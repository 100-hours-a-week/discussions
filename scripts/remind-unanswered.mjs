// 엔트리: 미답변 디스커션 리마인드
// 레포의 모든 디스커션을 조회해 미답변 건을 모아 디스코드로 발송한다.

import { pathToFileURL } from 'node:url';
import {
  resolveTransport,
  sendBotMessage,
  sendLongMessage,
  sendToDiscord,
} from './lib/discord.mjs';
import { buildReminderMessage, collectReminderMentionIds } from './lib/message.mjs';
import {
  DEFAULT_ANSWERED_LABELS,
  fetchAllDiscussions,
  filterByCategories,
  filterByCreatedSince,
  hasTruncatedComments,
  isUnanswered,
  toReminderItem,
} from './lib/discussions.mjs';
import {
  findMentorDiscordId,
  findMentorDiscordUsername,
  loadMentorMappingFromEnv,
  mentorMappingSourceLabel,
  parseDesiredMentor,
  resolveJudgmentLogin,
  resolveMentorLogin,
} from './lib/mentors.mjs';

async function main() {
  // 전송 계층 선택: 봇 토큰+REMIND_CHANNEL_ID가 있으면 봇(리마인드 채널 발송),
  // 없으면 기존 리마인드 웹훅으로 폴백한다(무중단 전환). 리마인드는 스레드를 쓰지 않는다.
  const transport = resolveTransport('remind');
  if (transport.mode === 'bot') {
    console.log(`리마인드 봇 채널: ${transport.channelEnvName}`);
  } else {
    console.log(`리마인드 웹훅: ${transport.envName}`);
    if (transport.partialBot) {
      console.warn(
        '경고: DISCORD_BOT_TOKEN은 설정됐지만 REMIND_CHANNEL_ID가 없어 웹훅으로 폴백합니다.',
      );
    }
  }
  const token = requireEnv('GITHUB_TOKEN');
  const repository = requireEnv('GITHUB_REPOSITORY'); // "owner/name" — Actions가 자동 주입
  const [owner, name] = repository.split('/');
  if (!owner || !name) {
    throw new Error(`GITHUB_REPOSITORY 형식이 잘못되었습니다: "${repository}" (owner/name 형식이어야 함)`);
  }

  const categoryFilter = parseList(process.env.DISCUSSION_CATEGORIES);
  const answeredLabels = parseList(process.env.ANSWERED_LABELS);
  const mentionContent = (process.env.MENTION_CONTENT ?? '').trim();

  // 답변 희망 멘토 추적: 멘토 매핑(사내 핸들 → 깃헙 로그인)이 있으면 활성화된다.
  // 매핑은 Secret MENTORS_JSON 우선, 없으면 mentors.json 파일 폴백 (loadMentorMappingFromEnv 참고).
  // REQUIRE_ASSIGNED_MENTOR_ANSWER=true면 "지정 멘토 본인이 답변해야 완료"로 판정을 강화.
  const mentorMapping = loadMentorMappingFromEnv();
  const requireMentorAnswer =
    (process.env.REQUIRE_ASSIGNED_MENTOR_ANSWER ?? '').trim().toLowerCase() === 'true';
  if (Object.keys(mentorMapping).length === 0) {
    console.log(
      `멘토 매핑 없음 [출처: ${mentorMappingSourceLabel()}] — 본문 @핸들만으로 담당 멘토를 표시합니다.`,
    );
    if (requireMentorAnswer) {
      console.warn(
        `경고: REQUIRE_ASSIGNED_MENTOR_ANSWER=true이지만 멘토 매핑이 없어 판정 강화가 적용되지 않습니다(기본 판정으로 폴백) [출처: ${mentorMappingSourceLabel()}].`,
      );
    }
  } else {
    console.log(
      `멘토 매핑 ${Object.keys(mentorMapping).length}개 [출처: ${mentorMappingSourceLabel()}]`,
    );
  }

  const all = await fetchAllDiscussions({ owner, name, token });
  const targets = filterByCreatedSince(
    filterByCategories(all, categoryFilter),
    process.env.REMIND_SINCE,
  );

  const evaluated = targets.map((discussion) => {
    const desired = parseDesiredMentor(discussion);
    return {
      discussion,
      mentorHandle: desired?.handle ?? desired?.githubLogin ?? null,
      // 표시·그룹핑용(매핑 우선, 표기 @핸들 폴백)과 판정용(검증된 로그인만)을 분리한다.
      mentorLogin: resolveMentorLogin(desired, mentorMapping),
      judgmentLogin: resolveJudgmentLogin(desired, mentorMapping),
    };
  });

  const unansweredNodes = evaluated.filter(({ discussion, judgmentLogin }) =>
    isUnanswered(discussion, {
      answeredLabels: answeredLabels.length > 0 ? answeredLabels : DEFAULT_ANSWERED_LABELS,
      // 판정 강화는 검증된 멘토 로그인이 있는 글에만 적용 (해석 불가 시 기존 판정으로 폴백)
      requiredAnswererLogin: requireMentorAnswer ? judgmentLogin : null,
    }),
  );

  for (const { discussion } of unansweredNodes) {
    if (hasTruncatedComments(discussion)) {
      console.warn(
        `경고: #${discussion.number} 코멘트가 조회 한도를 넘어 일부만 판정에 사용됨 (미답변으로 유지)`,
      );
    }
  }

  // 멘토 그룹 헤더에 실제 디스코드 멘션을 넣기 위해 담당 멘토의 디스코드 유저 ID를 실어 보낸다.
  const unanswered = unansweredNodes.map(({ discussion, mentorHandle, mentorLogin }) => ({
    ...toReminderItem(discussion),
    mentor: mentorHandle,
    mentorLogin,
    discordId: findDiscordIdFor(mentorMapping, mentorHandle, mentorLogin),
    discordUsername: findDiscordUsernameFor(mentorMapping, mentorHandle, mentorLogin),
  }));
  console.log(
    `디스커션 전체 ${all.length}건 / 대상 ${targets.length}건 / 미답변 ${unanswered.length}건`,
  );

  // 리마인드 본문에는 학생이 작성한 제목이 그대로 들어간다. 따라서 멘션은 전면 허용하지 않고
  // "이 메시지가 실제로 멘션한 멘토 ID"만 화이트리스트로 넘긴다.
  // → 제목에 @everyone/@here/@다른유저가 들어 있어도 핑되지 않는다(멘션 인젝션 방지).
  const message = buildReminderMessage(unanswered);
  const allowedUserIds = collectReminderMentionIds(unanswered);
  console.log(`멘션 화이트리스트 멘토 ${allowedUserIds.length}명`);

  let chunkCount;
  if (transport.mode === 'bot') {
    // 운영자가 작성한 MENTION_CONTENT만 멘션 전면 허용 대상이다(학생 입력이 섞이지 않는 문구).
    if (mentionContent) {
      await sendBotMessage(transport.token, transport.channelId, mentionContent, { allowMentions: true });
    }
    ({ chunkCount } = await sendBotMessage(transport.token, transport.channelId, message, { allowedUserIds }));
  } else {
    if (mentionContent) {
      await sendToDiscord(transport.url, mentionContent, { allowMentions: true });
    }
    chunkCount = await sendLongMessage(transport.url, message, { allowedUserIds });
  }
  console.log(`리마인드 전송 완료 (메시지 ${chunkCount}건)`);
}

/**
 * 담당 멘토의 디스코드 유저 ID를 찾는다 (사내 핸들 우선, 없으면 깃헙 로그인으로 역조회).
 * 매핑에 디스코드 정보가 없는 멘토(genos.lee, edward.kk 등)와 구 평면 스키마에서는 null이므로
 * 멘션 없이 이름만 표시된다(기존 동작 유지).
 *
 * 값의 형식 검증(유저네임을 ID로 오인한 설정)은 여기서 다시 하지 않는다.
 *  - 1차 방어선: mentors.mjs가 매핑 로드 시 설정 오류로 실패시킨다(발송 전 fail-fast).
 *  - 2차 방어선: message.mjs가 스노플레이크 형식인 값만 `<@ID>`로 렌더링하고 화이트리스트에 넣는다.
 * 따라서 깨진 `<@유저네임>`이 발송되거나 잘못된 대상이 핑될 경로가 없다.
 * @param {Record<string, unknown>} mapping
 * @param {string|null} handle 사내 핸들 표기
 * @param {string|null} login 해석된 깃헙 로그인
 * @returns {string|null}
 */
export function findDiscordIdFor(mapping, handle, login) {
  return (
    (handle ? findMentorDiscordId(mapping, handle) : null) ??
    (login ? findMentorDiscordId(mapping, login) : null)
  );
}

/**
 * 멘션 폴백 2순위 — 숫자 ID가 없을 때 표기용 디스코드 유저네임을 찾는다(핑 안 됨).
 * @param {Record<string, unknown>} mapping
 * @param {string|null} handle 사내 핸들 표기
 * @param {string|null} login 해석된 깃헙 로그인
 * @returns {string|null}
 */
export function findDiscordUsernameFor(mapping, handle, login) {
  return (
    (handle ? findMentorDiscordUsername(mapping, handle) : null) ??
    (login ? findMentorDiscordUsername(mapping, login) : null)
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

// 테스트가 순수 함수를 import할 때 main이 실행되지 않도록, 직접 실행된 경우에만 구동한다
// (poll-new-discussions.mjs와 동일한 패턴).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
