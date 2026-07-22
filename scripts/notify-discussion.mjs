// 엔트리: 새 디스커션 등록 시 디스코드 알림
// GitHub Actions의 discussion(created) 이벤트 페이로드를 읽어 웹훅으로 전송한다.

import { readFile } from 'node:fs/promises';
import {
  deliverNewDiscussion,
  isDiscordUserId,
  resolveTransport,
  sendLongMessage,
} from './lib/discord.mjs';
import { buildNewDiscussionMessage } from './lib/message.mjs';
import { matchesCategory } from './lib/discussions.mjs';
import {
  findMentorDiscordId,
  findMentorDiscordUsername,
  loadMentorMappingFromEnv,
  parseDesiredMentor,
} from './lib/mentors.mjs';

async function main() {
  // 전송 계층 선택: 봇 토큰+FEED_CHANNEL_ID가 있으면 봇(채널 발송 후 스레드 생성),
  // 없으면 기존 피드 웹훅으로 폴백한다(무중단 전환).
  const transport = resolveTransport('feed');
  if (transport.mode === 'bot') {
    console.log(`피드 봇 채널: ${transport.channelEnvName}`);
  } else {
    console.log(`피드 웹훅: ${transport.envName}`);
    if (transport.partialBot) {
      console.warn(
        '경고: DISCORD_BOT_TOKEN은 설정됐지만 FEED_CHANNEL_ID가 없어 웹훅으로 폴백합니다(스레드 비활성).',
      );
    }
  }
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
  const mentorHandle = desired?.handle ?? desired?.githubLogin ?? null;

  // 답변 희망 멘토가 mentors.json에 매핑돼 있으면 즉시 @멘션한다(질문 올라오자마자 담당 멘토 알림).
  // 매핑 없음/디스코드 정보 없음이면 태그 없이 텍스트만(3단 폴백). 학생 제목의 임의 멘션은
  // 화이트리스트(지정 멘토 ID만)로 차단한다 — 리마인드와 동일한 인젝션 방지.
  const mentorMapping = loadMentorMappingFromEnv();
  const mentorLookup = desired?.handle ?? desired?.githubLogin ?? null;
  const mentorDiscordId = mentorLookup ? findMentorDiscordId(mentorMapping, mentorLookup) : null;
  const mentorDiscordUsername = mentorLookup
    ? findMentorDiscordUsername(mentorMapping, mentorLookup)
    : null;
  const allowedUserIds = isDiscordUserId(mentorDiscordId) ? [mentorDiscordId] : [];

  const message = buildNewDiscussionMessage({
    title: discussion.title,
    url,
    author: discussion.user?.login ?? '(알 수 없음)',
    category: categoryName,
    mentor: mentorHandle,
    mentorDiscordId,
    mentorDiscordUsername,
  });

  if (transport.mode === 'bot') {
    const result = await deliverNewDiscussion(transport, {
      number: discussion.number,
      title: discussion.title,
      content: message,
    }, { allowedUserIds });
    if (result.threadError) {
      console.warn(
        `경고: #${discussion.number} 스레드 생성 실패(메시지는 전송됨): ${result.threadError}`,
      );
    } else if (!result.messageId) {
      console.warn(
        `경고: #${discussion.number} 메시지 ID를 받지 못해 스레드를 만들지 못했습니다(메시지는 전송됨).`,
      );
    } else if (!result.threadId) {
      console.warn(
        `경고: #${discussion.number} 스레드 ID를 응답에서 받지 못해 스레드를 만들지 못했습니다(메시지는 전송됨).`,
      );
    }
  } else {
    await sendLongMessage(transport.url, message, { allowedUserIds });
  }
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
