// 디스코드 메시지 빌더 (순수 함수)

/**
 * 새 디스커션 등록 알림 메시지. 본문 미리보기는 넣지 않는다.
 * @param {{title: string, url: string, author: string, category: string, mentor?: string|null}} discussion
 * @returns {string}
 */
export function buildNewDiscussionMessage(discussion) {
  const { title, url, author, category, mentor = null } = discussion;

  let message = `## 새 디스커션 등록\n`;
  message += `**[${category}] ${title}**\n`;
  message += `- 작성자: \`${author}\`\n`;
  if (mentor) message += `- 답변 희망 멘토: \`${mentor}\`\n`;
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
 * 미답변 디스커션 리마인드 메시지.
 * 미답변 디스커션을 한눈에 확인할 수 있도록 목록형 메시지로 구성한다.
 * 주의: 멘션 문구는 여기에 넣지 않는다 — 학생이 작성한 제목이 본문에 포함되므로
 * 멘션을 허용한 채 합쳐 보내면 제목 속 @everyone 등이 실제 핑되는 인젝션이 가능하다.
 * (멘션은 엔트리에서 별도 선행 메시지로 전송)
 * @param {Array<{title: string, url: string, author: string, category: string, labels?: string[], mentor?: string|null, mentorLogin?: string|null}>} unanswered
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
    const mentorKeys = [...groups.keys()]
      .filter((key) => key !== null)
      .sort((a, b) => labelOf(groups.get(a)).localeCompare(labelOf(groups.get(b))));
    for (const key of mentorKeys) {
      const items = groups.get(key);
      message += `\n**${labelOf(items)}** 멘토님 (${items.length}건)\n`;
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
