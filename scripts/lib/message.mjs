// 디스코드 메시지 빌더 (순수 함수)

import { isDiscordUserId } from './discord.mjs';

/**
 * 답변 희망 멘토 표기 뒤에 붙일 디스코드 태그(3단 폴백). 리마인드 그룹 헤더와 동일 규칙:
 *  1) 유효한 숫자 ID → ` <@ID>` (실제 핑)  2) 유저네임만 → ` (@유저네임)` (핑 없음)  3) 없음 → ''
 * 스노플레이크가 아닌 값으로는 절대 `<@값>`을 만들지 않는다(깨진 멘션·인젝션 방지).
 * @param {string|null} discordId
 * @param {string|null} discordUsername
 * @returns {string}
 */
function mentorTag(discordId, discordUsername) {
  if (isDiscordUserId(discordId)) return ` <@${discordId}>`;
  const username = (discordUsername ?? '').trim();
  return username ? ` (@${username})` : '';
}

/**
 * 새 디스커션 등록 알림 메시지. 본문 미리보기는 넣지 않는다.
 * 답변 희망 멘토가 mentors.json에 매핑돼 디스코드 ID가 있으면 실제 @멘션으로 즉시 알린다.
 * @param {{title: string, url: string, author: string, category: string, mentor?: string|null, mentorDiscordId?: string|null, mentorDiscordUsername?: string|null}} discussion
 * @returns {string}
 */
export function buildNewDiscussionMessage(discussion) {
  const { title, url, author, category, mentor = null, mentorDiscordId = null, mentorDiscordUsername = null } = discussion;

  let message = `## 새 디스커션 등록\n`;
  message += `**[${category}] ${title}**\n`;
  message += `- 작성자: \`${author}\`\n`;
  if (mentor) message += `- 답변 희망 멘토: \`${mentor}\`${mentorTag(mentorDiscordId, mentorDiscordUsername)}\n`;
  message += `- 링크: <${url}>`;
  return message;
}

/**
 * 새 코멘트(답변) 등록 알림 메시지. 답변 내용 미리보기는 넣지 않는다.
 * 답변자는 mentors.json에서 사내 핸들로 해석된 멘토일 때만 표기한다 (그 외에는 줄 생략).
 * @param {{title: string, url: string, mentorHandle?: string|null, category: string}} comment
 * @returns {string}
 */
export function buildNewCommentMessage(comment) {
  const { title, url, mentorHandle = null, category } = comment;

  let message = `## 새 답변(코멘트) 등록\n`;
  message += `**[${category}] ${title}**\n`;
  if (mentorHandle) message += `- 답변자: \`${mentorHandle}\` 멘토님\n`;
  message += `- 링크: <${url}>`;
  return message;
}

/**
 * 리마인드 아이템에서 멘션 가능한 디스코드 유저 ID를 순서대로 중복 없이 모은다.
 * buildReminderMessage가 실제로 `<@ID>`를 렌더링하는 기준(isDiscordUserId)과 동일하므로,
 * 이 목록을 그대로 allowed_mentions 화이트리스트로 넘기면
 * "본문에 렌더링된 멘션 = 핑이 허용된 대상"이 항상 일치한다.
 * @param {Array<{discordId?: string|null}>} unanswered
 * @returns {string[]}
 */
export function collectReminderMentionIds(unanswered) {
  const ids = [];
  for (const item of unanswered) {
    const id = item?.discordId;
    if (isDiscordUserId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 미답변 디스커션 리마인드 메시지.
 * 미답변 디스커션을 한눈에 확인할 수 있도록 목록형 메시지로 구성한다.
 *
 * 멘토 그룹 헤더에는 담당 멘토의 디스코드 멘션(`<@ID>`)을 함께 넣는다. 다만 본문에는
 * 학생이 작성한 제목이 그대로 포함되므로, **전송 시 반드시 멘션 화이트리스트를 걸어야 한다**
 * (collectReminderMentionIds → sendLongMessage(..., { allowedUserIds })).
 * 멘션을 전면 허용(allowMentions=true)한 채 보내면 제목 속 @everyone/@here가 실제로
 * 핑되는 멘션 인젝션이 가능하다.
 * @param {Array<{title: string, url: string, author: string, category: string, labels?: string[], mentor?: string|null, mentorLogin?: string|null, discordId?: string|null, discordUsername?: string|null}>} unanswered
 * @returns {string}
 */
export function buildReminderMessage(unanswered) {
  let message = `## 미답변 디스커션 리마인드\n`;

  if (unanswered.length === 0) {
    message += `모든 디스커션에 답변이 완료되었습니다.\n`;
    message += `감사합니다!`;
    return message;
  }

  message += `안녕하세요, 멘토님들!\n`;
  message += `아직 답변이 완료되지 않은 디스커션이 있어 리마인드 드립니다.\n`;
  message += `**멘토링 당일 오전 9시까지** 답변을 완료해 주시면 감사하겠습니다!\n\n`;
  message += `[답변이 필요한 글]\n`;

  // 답변 희망 멘토 정보가 하나라도 있으면 멘토별로 묶어서 보여준다.
  // 그룹 키는 해석된 로그인(mentorLogin) 우선 — 여러 핸들 표기가 같은 멘토로
  // 해석되면 그룹도 하나로 합쳐진다. 라벨은 사내 핸들 표기를 우선 사용.
  const groupKeyOf = (item) => {
    const key = item.mentorLogin ?? item.mentor ?? null;
    return key ? key.toLowerCase() : null;
  };
  const hasMentorInfo = unanswered.some((item) => groupKeyOf(item) !== null);

  let index = 0;
  const formatItem = (item) => {
    index += 1;
    const labelInfo = item.labels?.length ? ` / 라벨: ${item.labels.join(', ')}` : '';
    return `${index}. ${item.title} / ${item.category} / 작성자: ${item.author}${labelInfo} / <${item.url}>\n`;
  };

  if (!hasMentorInfo) {
    unanswered.forEach((item) => {
      message += formatItem(item);
    });
  } else {
    const groups = new Map();
    for (const item of unanswered) {
      const key = groupKeyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const labelOf = (items) =>
      items.find((i) => i.mentor)?.mentor ?? items.find((i) => i.mentorLogin)?.mentorLogin;
    // 담당 멘토 표기 3단 폴백:
    //  1) 유효한 디스코드 숫자 ID → 실제 멘션 `<@ID>`
    //  2) ID는 없지만 유저네임이 있으면(서버 미입장 등) → `(@유저네임)` 텍스트만 (핑 안 됨)
    //  3) 둘 다 없으면 → 사내 핸들만 (아무것도 덧붙이지 않음)
    // 스노플레이크가 아닌 값으로는 절대 `<@값>`을 만들지 않는다(깨진 멘션 방지).
    const mentionOf = (items) => {
      const id = items.find((i) => isDiscordUserId(i.discordId))?.discordId;
      if (id) return ` <@${id}>`;
      const username = items.find((i) => (i.discordUsername ?? '').trim())?.discordUsername;
      return username ? ` (@${username.trim()})` : '';
    };
    const mentorKeys = [...groups.keys()]
      .filter((key) => key !== null)
      .sort((a, b) => labelOf(groups.get(a)).localeCompare(labelOf(groups.get(b))));
    for (const key of mentorKeys) {
      const items = groups.get(key);
      message += `\n**${labelOf(items)}** 멘토님${mentionOf(items)} (${items.length}건)\n`;
      items.forEach((item) => {
        message += formatItem(item);
      });
    }
    if (groups.has(null)) {
      const items = groups.get(null);
      message += `\n**담당 미지정** (${items.length}건)\n`;
      items.forEach((item) => {
        message += formatItem(item);
      });
    }
  }

  message += `\n디스커션에 **코멘트를 남기거나 Mark as answer** 처리하시면 다음 리마인드에서 자동 제외됩니다.`;
  return message;
}
