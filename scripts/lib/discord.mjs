// Discord 웹훅 전송 유틸리티
// content 2000자 제한 → 줄 단위 분할, 429(rate limit) 1회 재시도

export const DISCORD_CONTENT_LIMIT = 2000;

// allowed_mentions.users 배열의 디스코드 제한 (초과하면 400)
export const DISCORD_ALLOWED_USERS_LIMIT = 100;

// 디스코드 스노플레이크 ID (현재 17~19자리, 여유를 두어 20자리까지 허용)
const SNOWFLAKE_RE = /^\d{17,20}$/;

const CHUNK_SEND_INTERVAL_MS = 400;

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 2000자를 넘는 메시지를 줄 단위로 분할한다.
 * 한 줄 자체가 limit을 넘으면 말줄임(…) 처리한다.
 * @param {string} content
 * @param {number} limit
 * @returns {string[]}
 */
export function splitIntoChunks(content, limit = DISCORD_CONTENT_LIMIT) {
  if (content.length <= limit) return [content];

  const chunks = [];
  let current = '';
  for (const line of content.split('\n')) {
    const safeLine = line.length > limit ? truncateLine(line, limit) : line;
    if (current === '') {
      current = safeLine;
    } else if (current.length + 1 + safeLine.length <= limit) {
      current += `\n${safeLine}`;
    } else {
      chunks.push(current);
      current = safeLine;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * 디스코드 스노플레이크 ID 문자열인지 검사한다.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDiscordUserId(value) {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}

/**
 * allowed_mentions 페이로드를 만든다 (멘션 정책의 단일 진입점).
 *
 * 정책:
 *  - 기본(둘 다 미지정): `{ parse: [] }` — 본문에 @everyone/@here/@유저가 있어도 아무도 핑되지 않는다.
 *  - allowedUserIds 지정: `{ parse: [], users: [...] }` — **화이트리스트에 있는 유저 ID만** 핑된다.
 *    학생이 작성한 제목이 본문에 섞이는 메시지(리마인드)는 반드시 이 모드를 쓴다.
 *    parse에 'users'를 넣으면 users 배열이 무시(또는 400)되므로 절대 함께 넣지 않는다.
 *  - allowMentions=true: 전면 허용 — 운영자가 직접 작성한 문구(MENTION_CONTENT)에만 쓴다.
 *
 * allowMentions=true와 allowedUserIds를 함께 주는 것은 서로 모순된 설정이므로 명시적으로 실패시킨다.
 *
 * 화이트리스트는 **이 content에 실제로 멘션이 등장하는 ID로 좁혀서** 싣는다.
 * 긴 메시지가 청크로 쪼개질 때 멘션이 없는 청크에까지 전체 명단이 실리지 않도록 하기 위함이다
 * (권한은 필요한 메시지에만 최소로 부여).
 * @param {string} content 실제로 전송할 본문
 * @param {{allowMentions?: boolean, allowedUserIds?: string[]}} options
 * @returns {{parse: string[], users?: string[]}}
 */
export function buildAllowedMentions(content, { allowMentions = false, allowedUserIds = null } = {}) {
  if (allowedUserIds != null && !Array.isArray(allowedUserIds)) {
    throw new Error('allowedUserIds는 디스코드 유저 ID 문자열 배열이어야 합니다.');
  }

  const ids = allowedUserIds ?? [];
  if (ids.length > 0) {
    if (allowMentions) {
      throw new Error(
        'allowMentions=true와 allowedUserIds는 함께 쓸 수 없습니다 (전면 허용과 화이트리스트는 모순).',
      );
    }
    const invalid = ids.find((id) => !isDiscordUserId(id));
    if (invalid !== undefined) {
      throw new Error(`allowedUserIds에 디스코드 유저 ID가 아닌 값이 있습니다: ${JSON.stringify(invalid)}`);
    }
    const mentioned = [...new Set(ids)].filter((id) => mentionsUser(content, id));
    if (mentioned.length > DISCORD_ALLOWED_USERS_LIMIT) {
      throw new Error(
        `allowed_mentions.users는 최대 ${DISCORD_ALLOWED_USERS_LIMIT}개까지만 지정할 수 있습니다 (요청 ${mentioned.length}개).`,
      );
    }
    return { parse: [], users: mentioned };
  }

  return allowMentions ? { parse: ['everyone', 'roles', 'users'] } : { parse: [] };
}

/**
 * content에 해당 유저의 멘션 토큰이 들어 있는지 검사한다.
 * 디스코드는 `<@id>`와 (구형) `<@!id>` 두 표기를 모두 멘션으로 해석하므로 둘 다 본다.
 * @param {string} content
 * @param {string} userId 스노플레이크 ID (검증 완료된 값)
 * @returns {boolean}
 */
function mentionsUser(content, userId) {
  const text = String(content ?? '');
  return text.includes(`<@${userId}>`) || text.includes(`<@!${userId}>`);
}

/**
 * 디스코드 웹훅으로 메시지 1건 전송.
 * 기본은 멘션 전면 차단이다. allowedUserIds를 주면 그 유저 ID만 멘션이 허용된다
 * (buildAllowedMentions 참고).
 * @param {string} webhookUrl
 * @param {string} content
 * @param {{allowMentions?: boolean, allowedUserIds?: string[], fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 */
export async function sendToDiscord(webhookUrl, content, options = {}) {
  const {
    allowMentions = false,
    allowedUserIds = null,
    fetchImpl = fetch,
    waitFn = defaultWait,
  } = options;

  const payload = {
    content,
    allowed_mentions: buildAllowedMentions(content, { allowMentions, allowedUserIds }),
  };
  // 웹훅의 비밀값은 URL 자체(`.../webhooks/<id>/<token>`)다 — 리댁션 대상도 URL.
  await postJsonWithRetry(webhookUrl, payload, {
    fetchImpl,
    waitFn,
    secret: webhookUrl,
    secretPlaceholder: '[REDACTED_WEBHOOK_URL]',
    subject: '웹훅',
  });
}

/**
 * 디스코드에 JSON을 보내고(기본 POST) 429/5xx를 1회 재시도한다 (웹훅·봇 공용 저수준 전송).
 * 성공 시 Response를 그대로 반환한다 — 봇 모드는 응답 본문에서 message.id·thread.id를
 * 읽어야 하므로 호출자가 필요 시 body를 파싱할 수 있게 한다(웹훅은 무시).
 *
 * method로 PATCH(메시지 수정) 같은 다른 메서드도 같은 재시도·리댁션 정책을 공유한다.
 *
 * 실패 메시지에는 비밀값(웹훅 URL·봇 토큰)이 남지 않도록 secret을 placeholder로 가린다.
 * fetch가 던지는 오류·응답 본문 모두 퍼블릭 Actions 로그로 흘러가므로 반드시 리댁션한다.
 * @param {string} url
 * @param {object} payload JSON 직렬화할 본문
 * @param {{fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>, headers?: Record<string,string>, secret?: string, secretPlaceholder?: string, subject?: string, method?: string}} options
 * @returns {Promise<Response>}
 */
async function postJsonWithRetry(url, payload, options = {}) {
  const {
    fetchImpl = fetch,
    waitFn = defaultWait,
    headers = {},
    secret = url,
    secretPlaceholder = '[REDACTED]',
    subject = '요청',
    method = 'POST',
  } = options;

  const request = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  };

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, request);
    } catch (error) {
      throw new Error(
        `Discord ${subject} 요청 실패: ${redactSecret(error?.message ?? error, secret, secretPlaceholder)}`,
      );
    }
    if (response.ok) return response;

    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterSec = await readRetryAfterSeconds(response);
      await waitFn(Math.ceil(retryAfterSec * 1000));
      continue;
    }

    // 디스코드의 일시적인 5xx 응답에 대비해 1회 재시도한다.
    if (response.status >= 500 && attempt < maxAttempts) {
      await waitFn(1000);
      continue;
    }

    // 응답 본문에 요청 URL·토큰이 반향될 수 있으므로 비밀값은 지우고 남긴다.
    const body = await response.text().catch(() => '');
    throw new Error(
      `Discord ${subject} 전송 실패: HTTP ${response.status} ${redactSecret(body, secret, secretPlaceholder)}`.trim(),
    );
  }
}

/**
 * 문자열에서 비밀값(웹훅 URL·봇 토큰)을 지운다 — 로그·에러 유출 방지.
 * 웹훅 URL은 토큰 자체가 발송 권한이고, 봇 토큰도 유출 시 서버 제어권이 넘어가므로
 * 퍼블릭 Actions 로그에 조각이라도 남으면 안 된다.
 * @param {unknown} text
 * @param {string} secret 가릴 비밀값(URL 또는 토큰)
 * @param {string} placeholder 치환 문구
 * @returns {string}
 */
function redactSecret(text, secret, placeholder = '[REDACTED]') {
  const value = String(text ?? '');
  if (!secret) return value;
  return value.split(secret).join(placeholder);
}

/**
 * 긴 메시지를 청크로 나눠 순차 전송한다.
 * options는 각 청크 전송에 그대로 전달되지만, allowedUserIds 화이트리스트는 청크별로
 * "그 청크에 실제 멘션이 등장하는 ID"로만 좁혀져 실린다 (buildAllowedMentions 참고).
 * @param {string} webhookUrl
 * @param {string} content
 * @param {{allowMentions?: boolean, allowedUserIds?: string[], fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 */
export async function sendLongMessage(webhookUrl, content, options = {}) {
  const { waitFn = defaultWait } = options;
  const chunks = splitIntoChunks(content);
  for (let i = 0; i < chunks.length; i += 1) {
    await sendToDiscord(webhookUrl, chunks[i], options);
    if (i < chunks.length - 1) await waitFn(CHUNK_SEND_INTERVAL_MS);
  }
  return chunks.length;
}

// 채널 분리용 웹훅 환경변수 이름 (미설정이면 아래 FALLBACK_WEBHOOK_ENV로 폴백)
export const REMIND_WEBHOOK_ENV = 'DISCORD_WEBHOOK_URL_REMIND';
export const FEED_WEBHOOK_ENV = 'DISCORD_WEBHOOK_URL_FEED';
const FALLBACK_WEBHOOK_ENV = 'DISCORD_WEBHOOK_URL';

/**
 * 용도별 웹훅 URL을 해석한다 (리마인드 ↔ 새 글·코멘트 채널 분리).
 * 우선순위: 지정한 용도별 환경변수 → 기존 DISCORD_WEBHOOK_URL 폴백.
 * 폴백이 있으므로 용도별 변수를 설정하지 않아도 현행 그대로 한 채널로 동작한다(무중단 전환).
 *
 * Actions는 미설정 Secret을 빈 문자열로 주입하므로 공백뿐인 값은 미설정으로 본다
 * (MENTORS_JSON의 공백 처리와 동일 기준).
 * @param {string} preferredEnvName REMIND_WEBHOOK_ENV | FEED_WEBHOOK_ENV
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{url: string, envName: string, isFallback: boolean}}
 */
export function resolveWebhookUrl(preferredEnvName, { env = process.env } = {}) {
  const preferred = (env[preferredEnvName] ?? '').trim();
  if (preferred) return { url: preferred, envName: preferredEnvName, isFallback: false };

  const fallback = (env[FALLBACK_WEBHOOK_ENV] ?? '').trim();
  if (fallback) return { url: fallback, envName: FALLBACK_WEBHOOK_ENV, isFallback: true };

  throw new Error(
    `환경변수 ${preferredEnvName} 또는 ${FALLBACK_WEBHOOK_ENV} 중 하나는 설정되어야 합니다.`,
  );
}

// ---------------------------------------------------------------------------
// 봇 전송 계층
// DISCORD_BOT_TOKEN이 있으면 봇 API로, 없으면 기존 웹훅으로 자동 선택한다(무중단·폴백).
// 봇 모드에서만 스레드(새 글에 스레드 생성 → 답변을 그 스레드에 댓글)가 가능하다.
// ---------------------------------------------------------------------------

// 봇 모드 채널 ID 환경변수 이름 (리마인드/피드 분리)
export const REMIND_CHANNEL_ENV = 'REMIND_CHANNEL_ID';
export const FEED_CHANNEL_ENV = 'FEED_CHANNEL_ID';

// 디스코드 스레드 이름 길이 제한 (100자)
export const DISCORD_THREAD_NAME_LIMIT = 100;
// 스레드 자동 보관 시간(분): 7일 = 10080분 (디스코드 최대치)
const THREAD_AUTO_ARCHIVE_MINUTES = 10080;
// 보관 스레드 페이지네이션 상한 (무한 루프 방지)
const ARCHIVED_THREADS_MAX_PAGES = 20;

/**
 * 디스코드 REST API 베이스. 기본은 v10. 테스트·GHES 대응으로 DISCORD_API_BASE로 override 가능
 * (poll의 GITHUB_GRAPHQL_URL override와 동일한 원칙). 호출 시점에 읽어 자식 프로세스 env를 반영한다.
 * @returns {string}
 */
function apiBase() {
  return (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
}

/** 봇 인증 헤더 (`Authorization: Bot <token>`). */
function botHeaders(token) {
  return { Authorization: `Bot ${token}` };
}

/**
 * 전송 계층을 해석한다: 봇 토큰이 있으면 봇, 없으면 기존 웹훅으로 폴백한다(무중단 전환).
 *  - purpose 'remind' → REMIND_CHANNEL_ID / DISCORD_WEBHOOK_URL_REMIND
 *  - purpose 'feed'   → FEED_CHANNEL_ID  / DISCORD_WEBHOOK_URL_FEED
 *
 * 봇 토큰은 있으나 해당 채널 ID가 없으면(부분 설정) 웹훅으로 폴백하고 partialBot 플래그를 세운다.
 * 엔트리가 이 플래그로 경고를 남겨, 봇 채널 ID 누락이 조용히 웹훅으로 새는 일을 알린다(silent 금지).
 * 채널 ID도 없고 웹훅도 없으면 무엇으로도 보낼 수 없으므로 원인을 분명히 밝히며 실패한다.
 *
 * Actions는 미설정 값을 빈 문자열로 주입하므로 공백뿐인 값은 미설정으로 본다(resolveWebhookUrl과 동일).
 * @param {'remind'|'feed'} purpose
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{mode:'bot', token:string, channelId:string, guildId:string|null, feedChannelId:string|null, channelEnvName:string}
 *          | {mode:'webhook', url:string, envName:string, isFallback:boolean, partialBot:boolean}}
 */
export function resolveTransport(purpose, { env = process.env } = {}) {
  if (purpose !== 'remind' && purpose !== 'feed') {
    throw new Error(
      `resolveTransport: purpose는 'remind' 또는 'feed'여야 합니다 (받은 값: ${JSON.stringify(purpose)}).`,
    );
  }

  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const channelEnvName = purpose === 'remind' ? REMIND_CHANNEL_ENV : FEED_CHANNEL_ENV;
  const channelId = (env[channelEnvName] ?? '').trim();
  const guildId = (env.DISCORD_GUILD_ID ?? '').trim();
  const feedChannelId = (env[FEED_CHANNEL_ENV] ?? '').trim();

  if (token && channelId) {
    return {
      mode: 'bot',
      token,
      channelId,
      guildId: guildId || null,
      feedChannelId: feedChannelId || null,
      channelEnvName,
    };
  }

  const webhookEnvName = purpose === 'remind' ? REMIND_WEBHOOK_ENV : FEED_WEBHOOK_ENV;
  const partialBot = Boolean(token) && !channelId; // 봇 토큰만 있고 채널 ID가 없는 부분 설정
  try {
    const webhook = resolveWebhookUrl(webhookEnvName, { env });
    return { mode: 'webhook', ...webhook, partialBot };
  } catch (error) {
    if (partialBot) {
      throw new Error(
        `DISCORD_BOT_TOKEN은 설정됐지만 ${channelEnvName}가 없고, 폴백할 웹훅(${webhookEnvName} 또는 ${FALLBACK_WEBHOOK_ENV})도 없습니다.`,
      );
    }
    throw error;
  }
}

/**
 * 응답 본문에서 생성된 리소스 id를 안전하게 읽는다 (message/thread 공용).
 * 본문이 없거나 JSON이 아니거나 id가 문자열이 아니면 null.
 * @param {Response} response
 * @returns {Promise<string|null>}
 */
async function readResourceId(response) {
  if (!response || typeof response.json !== 'function') return null;
  try {
    const body = await response.json();
    return typeof body?.id === 'string' ? body.id : null;
  } catch {
    return null;
  }
}

/**
 * 봇 모드: 채널(또는 스레드) 1건에 content를 전송한다.
 * 2000자 초과 시 청크 분할, 각 청크는 buildAllowedMentions로 멘션 화이트리스트가 적용된다
 * (웹훅과 동일한 멘션 정책·청크·429/5xx 재시도를 공유). 스레드도 채널의 일종이라 같은
 * `/channels/{id}/messages` 엔드포인트를 쓴다(channelId에 스레드 ID를 넣으면 그 스레드로 전송).
 * @param {string} token 봇 토큰
 * @param {string} channelId 채널 ID 또는 스레드 ID
 * @param {string} content
 * @param {{allowMentions?: boolean, allowedUserIds?: string[], fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 * @returns {Promise<{messageId: string|null, chunkCount: number}>} 첫 청크 메시지의 id(스레드 생성용)
 */
export async function sendBotMessage(token, channelId, content, options = {}) {
  const {
    allowMentions = false,
    allowedUserIds = null,
    fetchImpl = fetch,
    waitFn = defaultWait,
  } = options;

  const chunks = splitIntoChunks(content);
  let firstMessageId = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const payload = {
      content: chunks[i],
      allowed_mentions: buildAllowedMentions(chunks[i], { allowMentions, allowedUserIds }),
    };
    const response = await postJsonWithRetry(`${apiBase()}/channels/${channelId}/messages`, payload, {
      fetchImpl,
      waitFn,
      headers: botHeaders(token),
      secret: token,
      secretPlaceholder: '[REDACTED_BOT_TOKEN]',
      subject: '봇',
    });
    if (i === 0) firstMessageId = await readResourceId(response);
    if (i < chunks.length - 1) await waitFn(CHUNK_SEND_INTERVAL_MS);
  }
  return { messageId: firstMessageId, chunkCount: chunks.length };
}

/**
 * 봇 모드: 이미 보낸 봇 메시지의 content를 통째로 교체한다 (PATCH /channels/{id}/messages/{id}).
 *
 * ⚠️ 디스코드에서 **메시지 수정은 핑(알림)을 발생시키지 않는다** — allowed_mentions로 화이트리스트를
 * 걸어도 수정된 본문의 멘션으로 새 알림이 가지 않는다. 기록(화면에 보이는 내용)만 바로잡는 용도이며,
 * 실제로 누군가에게 알려야 한다면 별도 메시지를 보내야 한다(deliverMentorAssigned 참고).
 *
 * 수정은 청크 분할이 불가능하다(메시지 1건 = 본문 1개). 2000자를 넘으면 조용히 잘리는 대신
 * 명시적으로 실패시킨다.
 * @param {string} token 봇 토큰
 * @param {string} channelId 메시지가 있는 채널 ID
 * @param {string} messageId 수정할 메시지 ID
 * @param {string} content 교체할 본문
 * @param {{allowMentions?: boolean, allowedUserIds?: string[], fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 * @returns {Promise<string|null>} 수정된 메시지 id (응답에서 못 읽으면 null)
 */
export async function editBotMessage(token, channelId, messageId, content, options = {}) {
  const {
    allowMentions = false,
    allowedUserIds = null,
    fetchImpl = fetch,
    waitFn = defaultWait,
  } = options;

  const text = String(content ?? '');
  if (text.length > DISCORD_CONTENT_LIMIT) {
    throw new Error(
      `메시지 수정 본문이 디스코드 제한(${DISCORD_CONTENT_LIMIT}자)을 초과했습니다 (${text.length}자) — 수정은 청크 분할이 불가능합니다.`,
    );
  }

  const payload = {
    content: text,
    allowed_mentions: buildAllowedMentions(text, { allowMentions, allowedUserIds }),
  };
  const response = await postJsonWithRetry(
    `${apiBase()}/channels/${channelId}/messages/${messageId}`,
    payload,
    {
      fetchImpl,
      waitFn,
      headers: botHeaders(token),
      secret: token,
      secretPlaceholder: '[REDACTED_BOT_TOKEN]',
      subject: '봇 메시지 수정',
      method: 'PATCH',
    },
  );
  return readResourceId(response);
}

/**
 * 봇 모드: 채널의 특정 메시지에 스레드를 생성한다. 생성된 스레드 id를 반환한다(실패 시 예외).
 * @param {string} token
 * @param {string} channelId 스레드를 걸 메시지가 있는 채널 ID
 * @param {string} messageId 스레드 시작점 메시지 ID
 * @param {string} name 스레드 이름
 * @param {{fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 * @returns {Promise<string|null>}
 */
export async function createThreadOnMessage(token, channelId, messageId, name, options = {}) {
  const { fetchImpl = fetch, waitFn = defaultWait } = options;
  const response = await postJsonWithRetry(
    `${apiBase()}/channels/${channelId}/messages/${messageId}/threads`,
    { name, auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES },
    {
      fetchImpl,
      waitFn,
      headers: botHeaders(token),
      secret: token,
      secretPlaceholder: '[REDACTED_BOT_TOKEN]',
      subject: '봇 스레드 생성',
    },
  );
  return readResourceId(response);
}

/**
 * 스레드 이름을 '#{번호} {제목}'으로 만든다. 디스코드 100자 제한을 넘으면 제목을 자르되
 * '#{번호} ' 접두는 항상 보존한다(코멘트 알림이 이 접두로 스레드를 찾기 때문).
 * 제목의 개행·연속 공백은 한 칸으로 정리한다(스레드 이름 안정화 + 로그 인젝션 방지).
 * @param {number|string} number 디스커션 번호
 * @param {string} title
 * @param {number} [limit]
 * @returns {string}
 */
export function buildThreadName(number, title, limit = DISCORD_THREAD_NAME_LIMIT) {
  const prefix = `#${number} `;
  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!cleanTitle) return `#${number}`;

  const full = prefix + cleanTitle;
  if (full.length <= limit) return full;

  const room = limit - prefix.length; // 제목에 허용되는 최대 길이
  if (room <= 1) return prefix.slice(0, limit).trimEnd();
  // 서로게이트 페어(이모지) 반쪽이 남지 않도록 마지막 하이 서로게이트는 제거한다.
  const cut = cleanTitle.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${prefix}${cut}…`;
}

/**
 * 스레드 이름이 정확히 '#{번호}' 경계로 시작하는지 검사한다.
 * '#239'가 '#2390'과 오매칭되지 않도록, 접두 뒤가 공백이거나(일반) 이름 끝이어야 한다
 * (디스코드가 이름 끝 공백을 트리밍해 정확히 '#{번호}'만 남는 경우도 허용).
 * @param {string} name
 * @param {number|string} number
 * @returns {boolean}
 */
export function threadMatchesNumber(name, number) {
  const value = String(name ?? '');
  const prefix = `#${number}`;
  if (value === prefix) return true;
  return value.startsWith(`${prefix} `);
}

/**
 * 봇 GET 요청 후 JSON 반환(실패 시 예외). 비밀값(토큰) 리댁션 포함.
 * POST 경로(postJsonWithRetry)와 동일하게 429/5xx는 1회 재시도한다 — 스레드 조회가
 * 일시적 rate limit로 실패해 코멘트가 스레드 대신 채널로 밀리는 것을 막기 위함이다.
 * @param {string} url
 * @param {string} token
 * @param {{fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} [options]
 * @returns {Promise<any>}
 */
async function botGetJson(url, token, { fetchImpl = fetch, waitFn = defaultWait } = {}) {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: botHeaders(token) });
    } catch (error) {
      throw new Error(
        `Discord 봇 조회 요청 실패: ${redactSecret(error?.message ?? error, token, '[REDACTED_BOT_TOKEN]')}`,
      );
    }
    if (response.ok) return response.json();

    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterSec = await readRetryAfterSeconds(response);
      await waitFn(Math.ceil(retryAfterSec * 1000));
      continue;
    }

    // 디스코드의 일시적인 5xx 응답에 대비해 1회 재시도한다.
    if (response.status >= 500 && attempt < maxAttempts) {
      await waitFn(1000);
      continue;
    }

    let body = '';
    try {
      body = await response.text();
    } catch {
      // 본문을 못 읽어도 상태코드만으로 진단 가능
    }
    throw new Error(
      `Discord 봇 조회 실패: HTTP ${response.status} ${redactSecret(body, token, '[REDACTED_BOT_TOKEN]')}`.trim(),
    );
  }
}

/**
 * 디스커션 번호로 피드 채널의 스레드를 찾는다. 활성 스레드 → 보관(공개) 스레드 순으로 조회하고,
 * 이름이 '#{번호}' 경계로 시작하는 첫 스레드의 id를 반환한다(없으면 null).
 * guildId가 없으면 길드 단위 API인 활성 스레드 조회를 건너뛴다(보관 스레드는 채널 단위라 조회 가능).
 * @param {string} token
 * @param {string|null} guildId
 * @param {string} feedChannelId
 * @param {number|string} number
 * @param {{fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 * @returns {Promise<string|null>}
 */
export async function findThreadByNumber(token, guildId, feedChannelId, number, options = {}) {
  const { fetchImpl = fetch, waitFn = defaultWait } = options;
  const getOptions = { fetchImpl, waitFn };

  // 1) 활성 스레드 (길드 전체 조회 → parent_id로 피드 채널만 필터)
  if (guildId) {
    const active = await botGetJson(`${apiBase()}/guilds/${guildId}/threads/active`, token, getOptions);
    const match = (active?.threads ?? []).find(
      (t) => t.parent_id === feedChannelId && threadMatchesNumber(t.name, number),
    );
    if (match) return match.id;
  }

  // 2) 보관된 공개 스레드 (채널 단위 — has_more면 archive_timestamp before 커서로 페이지네이션)
  let before = null;
  for (let page = 0; page < ARCHIVED_THREADS_MAX_PAGES; page += 1) {
    const query = `?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const archived = await botGetJson(
      `${apiBase()}/channels/${feedChannelId}/threads/archived/public${query}`,
      token,
      getOptions,
    );
    const threads = archived?.threads ?? [];
    const match = threads.find((t) => threadMatchesNumber(t.name, number));
    if (match) return match.id;
    if (!archived?.has_more || threads.length === 0) break;
    before = threads[threads.length - 1]?.thread_metadata?.archive_timestamp ?? null;
    if (!before) break;
  }

  return null;
}

/**
 * 새 디스커션 알림(봇 모드): 피드 채널에 메시지를 보낸 뒤 그 메시지에 '#{번호} 제목' 스레드를 만든다.
 * 스레드 생성이 실패해도 메시지는 이미 나갔으므로 예외로 잡을 실패시키지 않고 threadError로 알린다
 * (실패시키면 재시도 시 같은 메시지가 중복 발송된다 — 누락보다 중복이 안전하되, 중복 자체도 피한다).
 * @param {{token:string, channelId:string}} transport 봇 전송 계층(피드 채널)
 * @param {{number:number|string, title:string, content:string}} params
 * @param {object} options sendBotMessage/createThreadOnMessage 옵션(fetchImpl/waitFn 등)
 * @returns {Promise<{messageId: string|null, threadId: string|null, threadError?: string}>}
 */
export async function deliverNewDiscussion(transport, { number, title, content }, options = {}) {
  const { token, channelId } = transport;
  // 스레드는 첫 청크 메시지에 걸린다. buildNewDiscussionMessage 출력(제목+작성자+카테고리+링크)은
  // 깃헙 디스커션 제목 상한(256자)상 2000자를 넘지 않아 항상 단일 청크다. 만약 다청크가 되면
  // 2번째 이후 청크는 채널에 남고 스레드로 옮겨지지 않으므로, 단일 청크 전제를 유지해야 한다.
  const { messageId } = await sendBotMessage(token, channelId, content, options);
  if (!messageId) return { messageId: null, threadId: null };
  try {
    const threadId = await createThreadOnMessage(
      token,
      channelId,
      messageId,
      buildThreadName(number, title),
      options,
    );
    return { messageId, threadId };
  } catch (error) {
    return { messageId, threadId: null, threadError: error.message ?? String(error) };
  }
}

/**
 * 코멘트(답변) 알림(봇 모드): 해당 디스커션의 스레드를 #번호로 찾아 그 안에 코멘트를 남긴다.
 * 스레드를 못 찾거나 조회가 실패하면 피드 채널에 일반 메시지로 폴백한다(silent 금지 — reason 반환).
 * @param {{token:string, guildId:string|null, channelId:string}} transport 봇 전송 계층(피드 채널)
 * @param {{number:number|string, content:string}} params
 * @param {object} options sendBotMessage/findThreadByNumber 옵션(fetchImpl/waitFn 등)
 * @returns {Promise<{via:'thread'|'channel', threadId: string|null, reason?: string, error?: string}>}
 */
export async function deliverThreadedComment(transport, { number, content }, options = {}) {
  const { token, guildId, channelId: feedChannelId } = transport;
  let threadId = null;
  try {
    threadId = await findThreadByNumber(token, guildId, feedChannelId, number, options);
  } catch (error) {
    // 조회 실패 시에도 알림 자체는 반드시 전달한다(채널 폴백).
    await sendBotMessage(token, feedChannelId, content, options);
    return { via: 'channel', threadId: null, reason: 'lookup-failed', error: error.message ?? String(error) };
  }
  if (threadId) {
    // 보관된 스레드라도 메시지를 보내면 자동으로 다시 열린다(unarchive).
    // 단, 스레드가 잠겼거나(잠긴 스레드는 전송해도 자동 unarchive되지 않음), 조회~전송 사이에
    // 삭제(404)됐거나, 429/5xx가 재시도까지 지속되면 전송이 실패할 수 있다. 이때도 알림을
    // 잃지 않도록 피드 채널로 폴백한다(조회 실패 경로와 대칭 — '항상 전달' 보장).
    try {
      await sendBotMessage(token, threadId, content, options);
      return { via: 'thread', threadId };
    } catch (error) {
      await sendBotMessage(token, feedChannelId, content, options);
      return {
        via: 'channel',
        threadId: null,
        reason: 'thread-post-failed',
        error: error.message ?? String(error),
      };
    }
  }
  // 스레드가 아예 없으면(원 글 알림 메시지가 삭제됐거나, 배포 전에 올라온 글이라 스레드가
  // 생긴 적이 없는 경우) **알리지 않는다** — 새 글 알림만 이어지는 피드 채널에 코멘트 메시지가
  // 단독으로 끼면 맥락 없이 지저분해지기 때문(운영 결정 2026-07-22).
  // 조회·전송 실패(lookup-failed / thread-post-failed)는 스레드가 있는데 못 쓴 경우라
  // 위에서 채널로 폴백한다 — 일시적 오류로 답변 알림을 잃지 않기 위함.
  return { via: 'skipped', threadId: null, reason: 'no-thread' };
}

/**
 * 답변 희망 멘토가 뒤늦게 지정·변경됐을 때의 반영(봇 모드).
 * 학생이 글을 올린 뒤 **수정해서** 멘토를 추가하는 실사용 패턴을 위한 경로다.
 *
 * 1) #번호로 원 글 스레드를 찾는다.
 *    **메시지에서 시작한 스레드는 스레드 ID == 시작점 메시지 ID**이므로(실측 확인),
 *    찾은 스레드 ID를 그대로 원본 피드 메시지 ID로 써서 본문을 갱신할 수 있다.
 * 2) 원본 피드 메시지를 갱신한다(기록 정확도). 수정은 핑을 발생시키지 않는다.
 * 3) 실제 알림을 위해 스레드 안에 멘션 메시지 1건을 남긴다(소통방 채널에는 새 메시지를 만들지 않는다).
 *
 * 스레드를 못 찾으면(원 글 알림이 삭제됐거나 봇 도입 전 글) 2·3 모두 건너뛴다 —
 * 피드 채널에 맥락 없는 메시지를 새로 만들지 않는다(deliverThreadedComment의 no-thread와 동일 원칙).
 *
 * 실패 정책:
 *  - 스레드 조회 실패 → 예외를 그대로 올린다(폴백 대상이 없으므로 조용히 넘기지 않는다).
 *  - 원본 갱신 실패 → editError로 알리고 **멘션 메시지는 계속 진행한다**(알림이 본질, 기록은 부수적).
 *  - 멘션 메시지 실패 → 예외를 그대로 올린다(멘토가 지정 사실을 못 받는 것은 실패다).
 * @param {{token:string, guildId:string|null, channelId:string}} transport 봇 전송 계층(피드 채널)
 * @param {{number:number|string, content:string, noticeContent:string|null}} params
 *        content=갱신할 원본 메시지 본문, noticeContent=스레드에 남길 멘션 메시지(없으면 생략)
 * @param {object} options sendBotMessage/editBotMessage/findThreadByNumber 옵션(fetchImpl/waitFn 등)
 * @returns {Promise<{threadId: string|null, updated: boolean, notified: boolean, reason?: string, editError?: string}>}
 */
export async function deliverMentorAssigned(
  transport,
  { number, content, noticeContent },
  options = {},
) {
  const { token, guildId, channelId: feedChannelId } = transport;

  const threadId = await findThreadByNumber(token, guildId, feedChannelId, number, options);
  if (!threadId) return { threadId: null, updated: false, notified: false, reason: 'no-thread' };

  // 스레드 ID == 원본 메시지 ID (메시지에서 시작한 스레드)
  let updated = false;
  let editError;
  try {
    await editBotMessage(token, feedChannelId, threadId, content, options);
    updated = true;
  } catch (error) {
    editError = error.message ?? String(error);
  }

  if (!noticeContent) {
    return { threadId, updated, notified: false, reason: 'no-notice', ...(editError ? { editError } : {}) };
  }

  await sendBotMessage(token, threadId, noticeContent, options);
  return { threadId, updated, notified: true, ...(editError ? { editError } : {}) };
}

function truncateLine(line, limit) {
  // 서로게이트 페어(이모지) 한가운데가 잘리면 lone surrogate가 남아 깨진 문자가 되므로 제거한다.
  const cut = line.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut}…`;
}

async function readRetryAfterSeconds(response) {
  try {
    const body = await response.clone().json();
    if (typeof body?.retry_after === 'number') return body.retry_after;
  } catch {
    // JSON 본문이 아니면 헤더로 폴백
  }
  const header = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(header) && header > 0 ? header : 1;
}
