// 엔트리: 디스커션 새 코멘트(답변) 등록 시 디스코드 알림
// GitHub Actions의 discussion_comment(created) 이벤트 페이로드를 읽어 웹훅으로 전송한다.

import { readFile } from 'node:fs/promises';
import { deliverThreadedComment, resolveTransport, sendLongMessage } from './lib/discord.mjs';
import { buildNewCommentMessage } from './lib/message.mjs';
import { matchesCategory } from './lib/discussions.mjs';
import {
  findMentorHandleByLogin,
  loadMentorMappingFromEnv,
  mentorMappingSourceLabel,
} from './lib/mentors.mjs';

async function main() {
  // 전송 계층 선택: 봇 토큰+FEED_CHANNEL_ID가 있으면 봇(디스커션 스레드에 댓글, 없으면 채널 폴백),
  // 없으면 기존 피드 웹훅으로 폴백한다(무중단 전환).
  const transport = resolveTransport('feed');
  if (transport.mode === 'bot') {
    console.log(`피드 봇 채널: ${transport.channelEnvName}`);
    // 활성(미보관) 스레드 조회는 길드 단위 API(GET /guilds/{id}/threads/active)로만 가능하다
    // — 채널 단위 활성 조회 엔드포인트는 API v10에 없다. DISCORD_GUILD_ID가 없으면 이 조회를
    // 건너뛰므로, 아직 보관되지 않은(최근 7일 이내) 디스커션의 코멘트는 스레드를 찾지 못하고
    // 매번 피드 채널로 폴백한다. 개별 코멘트 경고는 원인을 'not-found'로만 남겨 근본 원인이
    // 가려지므로, 시작 시 한 번 근본 원인을 크게 알린다(silent 금지).
    if (!transport.guildId) {
      console.warn(
        '경고: DISCORD_GUILD_ID 미설정 — 활성(미보관) 스레드 검색이 비활성화됩니다. ' +
          '최근 디스커션의 코멘트는 스레드를 찾지 못해 피드 채널로 폴백됩니다. ' +
          '스레드 연결을 원하면 DISCORD_GUILD_ID를 설정하세요.',
      );
    }
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
  const comment = event.comment;
  const discussion = event.discussion;
  if (!comment || !discussion) {
    throw new Error(
      '이벤트 페이로드에 comment/discussion이 없습니다. on: discussion_comment 트리거에서만 실행하세요.',
    );
  }

  const commenterLogin = comment.user?.login ?? null;
  const authorLogin = discussion.user?.login ?? null;

  // 글 작성자 본인의 코멘트(추가 질문·셀프 코멘트)는 답변이 아니므로 알리지 않는다.
  // (로그인이 확인되지 않으면 동일인 판별이 불가하므로 스킵하지 않는다 — 누락보다 중복이 안전)
  if (commenterLogin !== null && commenterLogin === authorLogin) {
    console.log(`작성자 본인(${commenterLogin})의 코멘트이므로 건너뜁니다.`);
    return;
  }

  // 봇 계정의 자동 코멘트는 알리지 않는다.
  if (comment.user?.type === 'Bot') {
    console.log(`봇 계정(${commenterLogin ?? '(알 수 없음)'})의 코멘트이므로 건너뜁니다.`);
    return;
  }

  const categoryName = discussion.category?.name ?? '(카테고리 없음)';

  // DISCUSSION_CATEGORIES가 설정된 경우 해당 카테고리만 알림 (비우면 전체) — 새 글 알림과 동일 기준
  const categoryFilter = parseList(process.env.DISCUSSION_CATEGORIES);
  if (!matchesCategory(categoryName, categoryFilter)) {
    console.log(`카테고리 "${categoryName}"는 알림 대상이 아니므로 건너뜁니다.`);
    return;
  }

  // 멘토 매핑 역조회: 답변자가 멘토면 사내 핸들을 병기해 표시한다.
  // 매핑은 Secret MENTORS_JSON 우선, 없으면 mentors.json 파일 폴백 (loadMentorMappingFromEnv 참고).
  const mentorMapping = loadMentorMappingFromEnv();
  const mentorHandle = findMentorHandleByLogin(mentorMapping, commenterLogin);

  // COMMENT_NOTIFY_MENTORS_ONLY=true면 멘토(매핑 값 목록)의 코멘트만 알린다.
  // 매핑이 없거나 비어 있으면 모든 코멘트가 스킵되는 조용한 실패가 되므로, 필터를 끄고
  // 경고만 남긴다 (REQUIRE_ASSIGNED_MENTOR_ANSWER의 폴백 동작과 동일한 원칙).
  const mentorsOnly =
    (process.env.COMMENT_NOTIFY_MENTORS_ONLY ?? '').trim().toLowerCase() === 'true';
  if (mentorsOnly) {
    if (Object.keys(mentorMapping).length === 0) {
      console.warn(
        `경고: COMMENT_NOTIFY_MENTORS_ONLY=true이지만 멘토 매핑이 없거나 비어 있어 멘토 필터가 적용되지 않습니다(전체 코멘트 알림) [출처: ${mentorMappingSourceLabel()}].`,
      );
    } else if (commenterLogin === null) {
      // 로그인이 확인되지 않으면 멘토 여부 판별이 불가 — 스킵하지 않고 발송한다
      // (위 작성자 본인 스킵과 동일한 fail-safe 원칙: 누락보다 중복이 안전).
      console.warn(
        '경고: 코멘트 작성자 로그인을 확인할 수 없어 멘토 여부 판별 없이 발송합니다 (COMMENT_NOTIFY_MENTORS_ONLY=true).',
      );
    } else if (mentorHandle === null) {
      console.log(
        `멘토 목록(멘토 매핑)에 없는 ${commenterLogin}의 코멘트이므로 건너뜁니다 (COMMENT_NOTIFY_MENTORS_ONLY=true).`,
      );
      return;
    }
  }

  // 코멘트 딥링크가 없으면 글 링크로, 그것도 없으면 레포 기준으로 구성한다 (새 글 알림과 동일한 폴백 원칙).
  const url =
    comment.html_url ??
    discussion.html_url ??
    `https://github.com/${event.repository?.full_name}/discussions/${discussion.number}`;

  const message = buildNewCommentMessage({
    title: discussion.title,
    url,
    mentorHandle,
    category: categoryName,
  });

  if (transport.mode === 'bot') {
    const result = await deliverThreadedComment(transport, {
      number: discussion.number,
      content: message,
    });
    if (result.via === 'thread') {
      console.log(`원 디스커션 스레드에 코멘트 등록: #${discussion.number} (thread ${result.threadId})`);
    } else {
      console.warn(
        `경고: #${discussion.number} 원 스레드에 남기지 못해 피드 채널에 표시했습니다 (${result.reason}${result.error ? `: ${result.error}` : ''}).`,
      );
    }
  } else {
    await sendLongMessage(transport.url, message);
  }
  console.log(
    `디스코드 알림 전송 완료: #${discussion.number} 새 코멘트 (답변자: ${commenterLogin ?? '(알 수 없음)'})`,
  );
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
