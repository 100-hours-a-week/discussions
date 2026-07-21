// 엔트리: 미답변 디스커션 리마인드
// 레포의 모든 디스커션을 조회해 미답변 건을 모아 디스코드로 발송한다.

import { sendLongMessage, sendToDiscord } from './lib/discord.mjs';
import { buildReminderMessage } from './lib/message.mjs';
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
  loadMentorMappingFromEnv,
  mentorMappingSourceLabel,
  parseDesiredMentor,
  resolveJudgmentLogin,
  resolveMentorLogin,
} from './lib/mentors.mjs';

async function main() {
  const webhookUrl = requireEnv('DISCORD_WEBHOOK_URL');
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

  const unanswered = unansweredNodes.map(({ discussion, mentorHandle, mentorLogin }) => ({
    ...toReminderItem(discussion),
    mentor: mentorHandle,
    mentorLogin,
  }));
  console.log(
    `디스커션 전체 ${all.length}건 / 대상 ${targets.length}건 / 미답변 ${unanswered.length}건`,
  );

  // 멘션은 별도 선행 메시지로만 보낸다. 본문에는 학생이 작성한 제목이 포함되므로
  // 멘션을 허용한 채 합쳐 보내면 제목 속 @everyone 등이 실제 핑되는 인젝션이 가능하다.
  if (mentionContent) {
    await sendToDiscord(webhookUrl, mentionContent, { allowMentions: true });
  }
  const chunkCount = await sendLongMessage(webhookUrl, buildReminderMessage(unanswered));
  console.log(`리마인드 전송 완료 (메시지 ${chunkCount}건)`);
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
