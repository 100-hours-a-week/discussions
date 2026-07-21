// 엔트리: 새 디스커션 등록 시 디스코드 알림
// GitHub Actions의 discussion(created) 이벤트 페이로드를 읽어 웹훅으로 전송한다.

import { readFile } from 'node:fs/promises';
import { sendLongMessage } from './lib/discord.mjs';
import { buildNewDiscussionMessage } from './lib/message.mjs';
import { matchesCategory } from './lib/discussions.mjs';
import { parseDesiredMentor } from './lib/mentors.mjs';

async function main() {
  const webhookUrl = requireEnv('DISCORD_WEBHOOK_URL');
  const eventPath = requireEnv('GITHUB_EVENT_PATH');

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const discussion = event.discussion;
  if (!discussion) {
    throw new Error('이벤트 페이로드에 discussion이 없습니다. on: discussion 트리거에서만 실행하세요.');
  }

  const categoryName = discussion.category?.name ?? '(카테고리 없음)';

  // DISCUSSION_CATEGORIES가 설정된 경우 해당 카테고리만 알림 (비우면 전체)
  const categoryFilter = parseList(process.env.DISCUSSION_CATEGORIES);
  if (!matchesCategory(categoryName, categoryFilter)) {
    console.log(`카테고리 "${categoryName}"는 알림 대상이 아니므로 건너뜁니다.`);
    return;
  }

  // org 디스커션의 html_url 포맷(레포형/조직형)은 공식 문서에 명시가 없다.
  // 어느 쪽이든 같은 글로 연결되므로 값을 그대로 쓰되, 없을 때만 레포 기준으로 구성한다.
  const url =
    discussion.html_url ??
    `https://github.com/${event.repository?.full_name}/discussions/${discussion.number}`;

  const desired = parseDesiredMentor({ title: discussion.title, body: discussion.body });

  const message = buildNewDiscussionMessage({
    title: discussion.title,
    url,
    author: discussion.user?.login ?? '(알 수 없음)',
    category: categoryName,
    mentor: desired?.handle ?? desired?.githubLogin ?? null,
  });

  await sendLongMessage(webhookUrl, message);
  // 퍼블릭 Actions 로그에 제목이 남는다 — 개행 포함 제목으로 ::커맨드:: 주입이 안 되도록 한 줄로 정리
  console.log(`디스코드 알림 전송 완료: #${discussion.number} ${String(discussion.title ?? '').replace(/\s+/g, ' ')}`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}이(가) 설정되지 않았습니다.`);
  return value;
}

function parseList(raw) {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
