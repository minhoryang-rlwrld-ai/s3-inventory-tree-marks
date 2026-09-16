#!/usr/bin/env node
// 이 저장소의 이슈를 훑어 marks.json 하나로 집계하고, 규칙을 벗어난 이슈를 정리한다.
//
// 뷰어가 브라우저에서 Issues API를 직접 부르면 무인증 호출이 IP당 시간당
// 60회로 제한되어 노드를 몇 번 펼치는 것만으로 한도에 닿는다. 그래서 결과를
// 정적 파일 하나로 만들어 두고 뷰어는 그것만 받아 간다.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/aggregate.mjs [--dry-run]

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const REPO   = process.env.GITHUB_REPOSITORY;
const TOKEN  = process.env.GITHUB_TOKEN;
const DRY    = process.argv.includes('--dry-run');
const OUT    = 'marks.json';

// 뷰어의 config.js marks.titlePrefix와 같아야 한다.
const PREFIX = 'mark: ';
const STATES = ['deletable', 'keep', 'backup-requested', 'backed-up'];
const TRIAGE = 'needs-triage';

// 이슈 본문과 코멘트에서 상태 명령을 읽는다. utterances 위젯은 코멘트만 남길 수
// 있고 라벨을 붙이지 못하므로, 사람이 뷰어에서 남긴 명령을 여기서 라벨로 옮긴다.
const COMMAND = new RegExp(`(?:^|\\s)/(${STATES.join('|')})(?=\\s|$)`, 'm');

// 누가 상태를 바꿀 수 있는지. 기본은 제한 없음이다. 저장소에 collaborator로
// 넣지 않아도 GitHub 계정만 있으면 마킹할 수 있어야 하기 때문이다.
//
// 조이려면 워크플로에서 ALLOW_ASSOCIATIONS를 지정한다.
// 예: ALLOW_ASSOCIATIONS=OWNER,MEMBER,COLLABORATOR
const ALLOWED = (process.env.ALLOW_ASSOCIATIONS || '*')
  .split(',').map((s) => s.trim().toUpperCase());
const OPEN_TO_ALL = ALLOWED.includes('*');

const parseCommand = (text) => {
  const m = COMMAND.exec(text || '');
  return m ? m[1] : null;
};
const authorized = (assoc) => OPEN_TO_ALL || ALLOWED.includes((assoc || 'NONE').toUpperCase());

// .github/ISSUE_TEMPLATE/mark.yml의 필드 라벨. 폼을 고치면 여기도 고쳐야 한다.
const FIELD = {
  path:      '경로',
  state:     '판단',
  reason:    '판단 근거',
  size:      '용량',
  count:     '파일 수',
  viewer:    '뷰어 링크',
  inventory: '인벤토리 기준',
};

/**
 * 이슈 폼이 만들어 낸 본문을 필드별로 가른다.
 *
 * 폼으로 만든 이슈는 본문이 `### 경로` 같은 제목과 값의 반복으로 렌더링된다.
 * 폼을 쓰지 않고 만든 이슈는 그냥 빈 객체가 나오며, 그때는 명령만 읽는다.
 */
function parseForm(body) {
  const out = {};
  if (!body) return out;
  for (const part of body.split(/^###[ \t]+/m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    const label = part.slice(0, nl).trim();
    let value = part.slice(nl + 1).trim();
    if (value === '_No response_' || value === '_No response_\n') value = '';
    out[label] = value;
  }
  return out;
}

/** 디렉터리 경로를 한 가지 모양으로 맞춘다. 앞의 슬래시를 떼고 뒤에 하나를 붙인다. */
function normalizePath(raw) {
  let p = (raw || '').trim().replace(/^\/+/, '');
  if (p && !p.endsWith('/')) p += '/';
  return p;
}

if (!REPO) { console.error('GITHUB_REPOSITORY가 필요합니다.'); process.exit(1); }
if (!TOKEN) { console.error('GITHUB_TOKEN이 필요합니다.'); process.exit(1); }

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

/** 열린 것과 닫힌 것을 모두 가져온다. 닫힌 이슈도 판단 이력이다. */
async function allIssues() {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
    // pull request는 issues API에도 섞여 나온다.
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return out;
  }
}

/**
 * 저장소의 이슈 코멘트를 전부 가져온다.
 * 이슈마다 따로 묻지 않고 저장소 단위 목록을 쓰면 호출이 한 자릿수로 끝난다.
 */
async function allComments() {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${REPO}/issues/comments?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const labelsOf = (issue) => issue.labels.map((l) => (typeof l === 'string' ? l : l.name));

function classify(issue) {
  const title = (issue.title || '').trim();
  const form = parseForm(issue.body);
  const fromTitle = title.startsWith(PREFIX) ? normalizePath(title.slice(PREFIX.length)) : '';
  const fromForm  = normalizePath(form[FIELD.path]);

  // 제목이 비어 있으면 폼 필드로 살린다. 폼을 손으로 채운 사람이 제목의
  // `mark: ` 뒤에 경로를 적지 않는 일이 흔하다.
  const path = fromTitle || fromForm;
  if (!path) {
    return { kind: 'malformed', form,
             reason: title.startsWith(PREFIX) ? '경로가 비어 있습니다' : '제목이 규칙을 벗어났습니다' };
  }
  if (fromTitle && fromForm && fromTitle !== fromForm) {
    return { kind: 'conflict', path: fromTitle, form,
             reason: `제목의 경로(${fromTitle})와 폼의 경로(${fromForm})가 다릅니다` };
  }

  const states = labelsOf(issue).filter((l) => STATES.includes(l));
  if (states.length > 1) {
    return { kind: 'conflict', path, form,
             reason: `상태 라벨이 ${states.join(', ')}로 겹칩니다` };
  }

  // 판단이 입력 필드라 오타가 날 수 있다. 무언가 적혀 있는데 아는 명령이
  // 아니면 조용히 넘기지 않는다. 무엇을 지울지 정하는 도구이기 때문이다.
  const typed = (form[FIELD.state] || '').trim();
  if (typed && !parseCommand(typed) && !states.length) {
    return { kind: 'conflict', path, form,
             reason: `판단 "${typed}"을 알아보지 못했습니다. `
                   + `${STATES.map((x) => '/' + x).join(', ')} 중 하나여야 합니다` };
  }

  return { kind: 'ok', path, form, state: states[0] || null, titleOk: fromTitle === path };
}

/**
 * 제목에 경로가 빠진 이슈의 제목을 고친다.
 * 뷰어의 댓글 위젯이 제목으로 스레드를 찾기 때문에 제목이 맞아야 한다.
 */
async function fixTitle(issue, path) {
  const want = PREFIX + path;
  if ((issue.title || '').trim() === want) return false;
  console.log(`  #${issue.number} 제목 고침: ${JSON.stringify(issue.title)} -> ${JSON.stringify(want)}`);
  if (DRY) return true;
  await api(`/repos/${REPO}/issues/${issue.number}`, {
    method: 'PATCH', body: JSON.stringify({ title: want }),
  });
  return true;
}

async function ensureTriage(issue, reason) {
  if (labelsOf(issue).includes(TRIAGE)) return false;
  console.log(`  #${issue.number} -> ${TRIAGE} (${reason})`);
  if (DRY) return true;
  await api(`/repos/${REPO}/issues/${issue.number}/labels`, {
    method: 'POST', body: JSON.stringify({ labels: [TRIAGE] }),
  });
  return true;
}

async function closeDuplicate(issue, keep, movedState) {
  if (issue.state === 'closed') return false;
  const extra = movedState ? ` 이 이슈의 \`${movedState}\` 판단은 원본으로 옮겼습니다.` : '';
  console.log(`  #${issue.number} 중복 -> 닫음 (원본 #${keep.number})${movedState ? ` [${movedState} 이관]` : ''}`);
  if (DRY) return true;
  await api(`/repos/${REPO}/issues/${issue.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `같은 경로의 이슈 #${keep.number}가 이미 있어 이 이슈를 닫습니다.${extra}` }),
  });
  await api(`/repos/${REPO}/issues/${issue.number}`, {
    method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
  });
  return true;
}

/** 중복 이슈에 있던 판단을 원본 이슈로 옮긴다. 사람이 남긴 판단을 버리지 않는다. */
async function moveState(canonical, state) {
  const current = labelsOf(canonical).filter((l) => STATES.includes(l));
  if (current.length === 1 && current[0] === state) return;
  console.log(`  #${canonical.number} 상태 라벨 ${current.join(',') || '없음'} -> ${state}`);
  if (DRY) return;
  for (const l of current) {
    if (l !== state) {
      await api(`/repos/${REPO}/issues/${canonical.number}/labels/${encodeURIComponent(l)}`,
                { method: 'DELETE' });
    }
  }
  if (!current.includes(state)) {
    await api(`/repos/${REPO}/issues/${canonical.number}/labels`,
              { method: 'POST', body: JSON.stringify({ labels: [state] }) });
  }
}

const [issues, comments] = await Promise.all([allIssues(), allComments()]);
console.log(`이슈 ${issues.length}건, 코멘트 ${comments.length}건`);

const commentsByIssue = new Map();
for (const c of comments) {
  const n = Number(c.issue_url.split('/').pop());
  if (!commentsByIssue.has(n)) commentsByIssue.set(n, []);
  commentsByIssue.get(n).push(c);
}

/** 이슈 하나에서 상태 명령을 모은다. 본문 하나와 코멘트 여러 개가 대상이다. */
function commandsOf(issue) {
  const out = [];
  const bodyState = parseCommand(issue.body);
  if (bodyState && authorized(issue.author_association)) {
    out.push({ state: bodyState, at: issue.created_at,
               actor: issue.user ? issue.user.login : null, where: `이슈 #${issue.number} 본문` });
  }
  for (const c of commentsByIssue.get(issue.number) || []) {
    const st = parseCommand(c.body);
    if (!st) continue;
    if (!authorized(c.author_association)) {
      console.log(`  #${issue.number} 코멘트의 /${st} 무시 (${c.author_association}, `
                + `ALLOW_ASSOCIATIONS=${ALLOWED.join(',')})`);
      continue;
    }
    out.push({ state: st, at: c.created_at,
               actor: c.user ? c.user.login : null, where: `이슈 #${issue.number} 코멘트` });
  }
  return out;
}

const byPath = new Map();
const problems = [];
const triage = new Map();   // 경로 -> 왜 검토가 필요한지

for (const issue of issues) {
  const c = classify(issue);
  if (c.kind === 'malformed') { problems.push([issue, c.reason]); continue; }
  if (c.kind === 'conflict')  { problems.push([issue, c.reason]); }
  // 검토 대상으로 넘긴 이슈는 경로만 붙잡아 두고 상태 판단에서는 뺀다.
  // 무엇을 지울지 정하는 도구이므로 모호한 입력을 임의로 해석하지 않는다.
  const excluded = c.kind === 'conflict';
  if (excluded) triage.set(c.path, { issue: issue.number, reason: c.reason });

  const list = byPath.get(c.path) || [];
  list.push({ issue, excluded, state: excluded ? null : c.state, form: c.form || {},
              titleOk: c.titleOk !== false,
              commands: excluded ? [] : commandsOf(issue) });
  byPath.set(c.path, list);
}

console.log('정리:');
for (const [issue, reason] of problems) await ensureTriage(issue, reason);

// 지난번 집계 결과. 어떤 명령까지 반영했는지 기억해 두어야 GitHub에서 손으로
// 고친 라벨을 다음 실행이 되돌려 놓지 않는다.
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).marks || {} : {};

const marks = {};
let duplicates = 0;
let applied = 0;
let retitled = 0;

for (const [path, list] of [...byPath].sort()) {
  // utterances는 페이지 식별자가 조금만 달라져도 새 이슈를 만들고, 뷰어의 상태
  // 버튼도 새 이슈를 연다. 번호가 가장 작은 것을 원본으로 삼고 나머지는 닫는다.
  list.sort((a, b) => a.issue.number - b.issue.number);
  const [head, ...rest] = list;

  // 라벨이 최종 상태이고 명령은 그 변경 요청이다. 지난 집계 뒤에 새로 들어온
  // 명령만 라벨에 반영한다.
  const prev = before[path] || {};
  const seen = prev.command_at ? Date.parse(prev.command_at) : 0;
  const cmds = list.flatMap((x) => x.commands)
                   .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const fresh = cmds.filter((c) => Date.parse(c.at) > seen);
  const newest = fresh.length ? fresh[fresh.length - 1] : null;

  const labelled = list.filter((x) => x.state)
                       .sort((a, b) => a.issue.number - b.issue.number)[0] || null;

  let state, actor, at;
  if (newest) {
    state = newest.state; actor = newest.actor; at = newest.at;
    console.log(`  ${path} <- /${state} (${newest.where}, ${newest.actor})`);
    applied++;
  } else if (labelled) {
    state = labelled.state;
    actor = labelled.issue.user ? labelled.issue.user.login : null;
    at = labelled.issue.updated_at;
  } else {
    state = null;
  }

  // 제목에 경로가 빠져 있었다면 폼에서 살려낸 경로로 제목을 고친다.
  // 뷰어의 댓글 위젯이 제목으로 스레드를 찾기 때문에 맞춰 두어야 한다.
  for (const x of list) {
    if (!x.excluded && !x.titleOk && await fixTitle(x.issue, path)) retitled++;
  }

  for (const dup of rest) {
    const moved = labelled && !newest && dup.issue.number === labelled.issue.number ? state : null;
    if (await closeDuplicate(dup.issue, head.issue, moved)) duplicates++;
  }
  if (state) await moveState(head.issue, state);

  if (!state) {
    if (triage.has(path)) {
      console.log(`  ${path} 상태를 정하지 않음 (검토 필요: ${triage.get(path).reason})`);
    }
    continue;
  }

  // 폼이 채워 준 값을 그대로 옮겨 둔다. 마킹한 시점의 용량이라 지금 인벤토리와
  // 다를 수 있고, 그 차이 자체가 판단을 다시 볼 근거가 된다.
  const form = (list.find((x) => x.form[FIELD.size]) || head).form;
  const context = {};
  for (const [key, label] of [['size', FIELD.size], ['count', FIELD.count],
                              ['inventory', FIELD.inventory]]) {
    if (form[label]) context[key] = form[label];
  }

  marks[path] = {
    state,
    issue: head.issue.number,                     // 뷰어가 여는 스레드는 언제나 원본
    actor,
    updated_at: at,
    // 여기까지 반영했다는 표시. 다음 실행이 같은 명령을 다시 적용하지 않는다.
    command_at: cmds.length ? cmds[cmds.length - 1].at : (prev.command_at || null),
    comments: list.reduce((a, x) => a + (x.issue.comments || 0), 0),
    closed: head.issue.state === 'closed',
    ...(Object.keys(context).length ? { at_marking: context } : {}),
  };
}

const doc = {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  repo: REPO,
  title_prefix: PREFIX,
  states: STATES,
  // 검토가 필요한 경로. 뷰어가 이 자리에 안내를 띄운다.
  triage: Object.fromEntries([...triage].sort()),
  counts: {
    issues: issues.length,
    marked: Object.keys(marks).length,
    needs_triage: problems.length,
    duplicates_closed: duplicates,
    commands_applied: applied,
    titles_fixed: retitled,
  },
  marks,
};

const text = JSON.stringify(doc, null, 2) + '\n';
const prevText = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';

// generated_at만 바뀐 경우에는 커밋하지 않는다. 매번 커밋이 쌓이면 이력이 지저분해진다.
const strip = (t) => t.replace(/"generated_at": "[^"]*",\n/, '');
const changed = strip(prevText) !== strip(text);

console.log(`마킹 ${doc.counts.marked}건 / 명령 반영 ${applied}건 / 제목 교정 ${retitled}건 / `
          + `정리 대상 ${problems.length}건 / 중복 닫음 ${duplicates}건`);
if (!changed) { console.log('변경 없음'); process.exit(0); }
if (DRY) { console.log('(dry-run) 쓰지 않음'); console.log(text); process.exit(0); }

writeFileSync(OUT, text);
console.log(`${OUT} 갱신`);
