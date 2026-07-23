// 엔트리: 새 디스커션 등록·수정 시 디스코드 알림
// GitHub Actions의 discussion(created/edited) 이벤트 페이로드를 읽어 전송한다.
//  - created: 피드 채널에 새 글 알림 발송 + 그 메시지에 스레드 생성 (기존 동작)
//  - edited : 답변 희망 멘토가 새로 지정·변경된 경우에만 원본 메시지를 갱신하고
//             원 글 스레드에 멘션 메시지 1건을 남긴다 (학생이 글을 올린 뒤 멘토를 추가하는 실사용 패턴)

import { readFile } from 'node:fs/promises';
import {
  deliverMentorAssigned,
  deliverNewDiscussion,
  isDiscordUserId,
  resolveTransport,
  sendLongMessage,
} from './lib/discord.mjs';
import { buildMentorAssignedMessage, buildNewDiscussionMessage } from './lib/message.mjs';
import { matchesCategory } from './lib/discussions.mjs';
import {
  findMentorDiscordId,
  findMentorDiscordUsername,
  findMentorEntry,
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

  // 처리 대상 액션만 통과시킨다. action이 없는 페이로드는 기존 동작(새 글)으로 본다.
  // 워크플로우가 types를 늘렸는데 스크립트가 모르는 액션이면 조용히 새 글로 오인해 중복 발송하는
  // 대신 명시적으로 건너뛴다.
  const action = event.action ?? 'created';
  if (action !== 'created' && action !== 'edited') {
    // 퍼블릭 Actions 로그에 그대로 남으므로 한 줄로 정리한다(::커맨드:: 주입 방지 — 제목 로그와 동일 기준)
    console.log(
      `discussion 액션 "${String(action).replace(/\s+/g, ' ')}"는 처리 대상이 아니므로 건너뜁니다.`,
    );
    return;
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

  if (action === 'edited') {
    await handleEdited({
      transport,
      event,
      discussion,
      message,
      desired,
      mentorMapping,
      mentorHandle,
      mentorDiscordId,
      mentorDiscordUsername,
      allowedUserIds,
    });
    return;
  }

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

/**
 * 디스커션 수정(edited) 처리.
 *
 * 학생이 답변 희망 멘토 없이 글을 올린 뒤 **글을 수정해서** 멘토를 추가하면, 이미 나간 알림에는
 * 멘션이 없어 멘토가 지정 사실을 모른다. 이 경로가 그 공백을 메운다.
 *
 * 스팸 방지를 위해 **가리키는 멘토가 실제로 달라졌을 때만** 동작한다(오타 수정·내용 보완 같은
 * 일반 수정은 물론, 같은 멘토를 다르게 적은 표기 변경도 무시한다 — sameMentor 참고).
 * 동작할 때는 원본 메시지를 현재 내용으로 갱신하고(기록 정확도),
 * 실제 핑을 위해 원 글 스레드에 멘션 메시지 1건을 남긴다 — 디스코드에서 메시지 수정은
 * 핑을 발생시키지 않기 때문이다.
 * @param {object} params
 */
async function handleEdited({
  transport,
  event,
  discussion,
  message,
  desired,
  mentorMapping,
  mentorHandle,
  mentorDiscordId,
  mentorDiscordUsername,
  allowedUserIds,
}) {
  const number = discussion.number;

  // 웹훅 모드에는 스레드도, 이미 보낸 메시지를 찾아 고칠 방법도 없다 — 아무것도 하지 않는다.
  // (피드 채널에 수정 알림을 새로 만들지 않는 것은 코멘트 알림의 no-thread 스킵과 같은 결정)
  if (transport.mode !== 'bot') {
    console.log(`#${number} 수정 이벤트: 웹훅 모드에서는 스레드가 없어 아무것도 하지 않습니다.`);
    return;
  }

  // 수정 전 상태 복원: discussion edited 페이로드의 changes에는 **바뀐 필드만** 담긴다
  // (제목만 고치면 changes.body가 없다 — 공식 스키마상 changes·title·body 모두 optional,
  //  from은 string). 없는 필드는 현재 값이 곧 수정 전 값이다.
  // `??`를 쓰므로 빈 문자열 from(본문을 통째로 지웠다 다시 쓴 경우)도 그대로 보존된다.
  const changes = event.changes ?? {};
  if (!changes.title && !changes.body) {
    // changes 자체가 없으면 수정 전 상태를 알 방법이 없다. 현재 값으로 추정하면 "변화 없음"으로
    // 보여 결국 스킵되지만, 왜 스킵됐는지 구분되도록 사유를 따로 남긴다(silent skip 금지).
    console.log(
      `#${number} 수정 이벤트에 제목·본문 변경 정보(changes)가 없어 수정 전 상태를 알 수 없습니다 — 오알림 방지를 위해 건너뜁니다.`,
    );
    return;
  }
  const previousDesired = parseDesiredMentor({
    title: changes.title?.from ?? discussion.title,
    body: changes.body?.from ?? discussion.body,
  });
  const previousHandle = previousDesired?.handle ?? previousDesired?.githubLogin ?? null;

  if (sameMentor(previousDesired, desired, mentorMapping)) {
    console.log(
      `#${number} 수정됐지만 답변 희망 멘토 변화가 없어 건너뜁니다 (현재: ${mentorHandle ?? '미지정'}).`,
    );
    return;
  }

  // 있음→없음(멘토 표기 제거)은 알릴 대상이 없다. 화면 기록만 현재 상태로 맞추고 멘션은 생략한다.
  const noticeContent = mentorHandle
    ? buildMentorAssignedMessage({
        mentor: mentorHandle,
        previousMentor: previousHandle,
        mentorDiscordId,
        mentorDiscordUsername,
      })
    : null;

  const result = await deliverMentorAssigned(
    transport,
    { number, content: message, noticeContent },
    { allowedUserIds },
  );

  if (result.reason === 'no-thread') {
    // 원 글 스레드가 없으면 갱신할 원본도, 알림을 남길 곳도 없다. 피드 채널에 새 메시지를
    // 만들지 않고 사유만 남긴다(의도된 스킵 — silent fail 아님).
    console.log(
      `#${number} 원 글 스레드가 없어 답변 희망 멘토 알림을 건너뜁니다 — ` +
        '원 글 알림 메시지가 삭제됐거나 봇 도입 전에 올라온 글입니다.',
    );
    return;
  }
  if (result.editError) {
    console.warn(`경고: #${number} 원본 메시지 갱신 실패(스레드 알림은 진행): ${result.editError}`);
  }
  if (!noticeContent) {
    console.log(
      `#${number} 답변 희망 멘토 표기가 제거되어 원본 메시지만 갱신했습니다 (이전: ${previousHandle}).`,
    );
    return;
  }
  console.log(
    `답변 희망 멘토 ${previousHandle ? '변경' : '지정'} 알림 완료: #${number} ` +
      `${previousHandle ?? '미지정'} → ${mentorHandle} (thread ${result.threadId})`,
  );
}

/**
 * 수정 전후의 답변 희망 멘토가 **같은 사람인지** 판정한다.
 *
 * 표기 문자열만 비교하면 같은 멘토를 다르게 적은 수정이 "변경"으로 오인돼, 이미 핑을 받은
 * 멘토에게 알림이 다시 가는 스팸이 된다. 실제로 흔한 표기 변화는 다음과 같다:
 *   - 본문 "@github-login-1" → "mentor.one(이름)/@github-login-1" (템플릿 형식대로 보강)
 *   - 본문에만 있던 표기를 제목 "(답변희망멘토: mentor.one)"로 옮김
 *   - 별칭 핸들(mentor.onee)을 정식 핸들(mentor.one)로 정정
 * 따라서 멘토 매핑으로 해석한 동일성 키로 비교한다.
 * @param {{handle: string|null, githubLogin: string|null}|null} previous
 * @param {{handle: string|null, githubLogin: string|null}|null} current
 * @param {Record<string, object|string>} mapping
 * @returns {boolean}
 */
function sameMentor(previous, current, mapping) {
  return mentorIdentity(previous, mapping) === mentorIdentity(current, mapping);
}

/**
 * 답변 희망 멘토 표기를 동일성 비교용 키로 바꾼다 (표기 없음이면 null).
 *
 * 매핑에서 멘토가 해석되면 **매핑 값**(깃헙 로그인·디스코드 ID·유저네임)으로 키를 만든다 —
 * 사내 핸들/깃헙 핸들/별칭 중 무엇으로 적었든 같은 키가 나온다. 매핑에 없거나(오타·미등록)
 * 매핑 값이 전부 비어 있어 키를 만들 수 없으면(서로 다른 멘토가 같은 빈 키로 뭉쳐
 * 진짜 변경을 놓치는 것을 막기 위해) 표기 문자열로 폴백한다.
 * @param {{handle: string|null, githubLogin: string|null}|null} desired
 * @param {Record<string, object|string>} mapping
 * @returns {string|null}
 */
function mentorIdentity(desired, mapping) {
  if (!desired) return null;

  // 사내 핸들 우선 조회 — 없을 때만 학생이 적은 @깃헙핸들로 역조회한다.
  const entry =
    findMentorEntry(mapping, desired.handle) ?? findMentorEntry(mapping, desired.githubLogin);
  if (entry) {
    const parts = [entry.github, entry.discord, entry.discordUsername].map((value) =>
      (value ?? '').trim().toLowerCase(),
    );
    if (parts.some(Boolean)) return `mentor:${parts.join('|')}`;
  }

  // 폴백: 표기 그대로 비교(대소문자·앞뒤 공백 무시) — 깃헙 로그인은 원문 대소문자라 정규화한다.
  return `label:${(desired.handle ?? desired.githubLogin ?? '').trim().toLowerCase()}`;
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
