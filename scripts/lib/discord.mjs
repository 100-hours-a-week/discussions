// Discord 웹훅 전송 유틸리티
// content 2000자 제한 → 줄 단위 분할, 429(rate limit) 1회 재시도

export const DISCORD_CONTENT_LIMIT = 2000;

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
 * 디스코드 웹훅으로 메시지 1건 전송.
 * allowMentions=false면 본문에 @everyone 등이 있어도 실제 멘션되지 않는다.
 * @param {string} webhookUrl
 * @param {string} content
 * @param {{allowMentions?: boolean, fetchImpl?: typeof fetch, waitFn?: (ms:number)=>Promise<void>}} options
 */
export async function sendToDiscord(webhookUrl, content, options = {}) {
  const { allowMentions = false, fetchImpl = fetch, waitFn = defaultWait } = options;

  const payload = {
    content,
    allowed_mentions: allowMentions
      ? { parse: ['everyone', 'roles', 'users'] }
      : { parse: [] },
  };
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(webhookUrl, request);
    if (response.ok) return;

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

    const body = await response.text().catch(() => '');
    throw new Error(`Discord 웹훅 전송 실패: HTTP ${response.status} ${body}`.trim());
  }
}

/**
 * 긴 메시지를 청크로 나눠 순차 전송한다.
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
