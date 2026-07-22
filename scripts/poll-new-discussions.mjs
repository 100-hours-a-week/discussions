// 엔트리: 폴링 폴백 — 신규 디스커션 감지 후 디스코드 알림
// org 디스커션이 discussion(created) 이벤트를 발화하지 않는 경우의 대비책이다.
// 마커 파일(마지막 확인 시각) 이후 생성된 디스커션을 GraphQL로 조회해 건별로 알림하고,
// 실행 후 마커를 갱신한다. 마커는 워크플로우에서 actions/cache로 실행 간 이어받는다.
// (discussion-notify-poll.yml 참고 — 평소에는 workflow_dispatch만 활성)

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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

const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';
const DEFAULT_MARKER_FILE = '.poll-marker';
const DEFAULT_LOOKBACK_MINUTES = 30;

// 신규 글 감지에 필요한 필드만 조회하는 경량 쿼리 (comments/labels 미포함).
// CREATED_AT DESC라 첫 페이지가 최신 글 — 페이지의 가장 오래된 글이 cutoff 이전이면
// 더 조회할 필요가 없으므로 페이지네이션을 조기 중단한다 (fetchDiscussionsSince 참고).
export const RECENT_DISCUSSIONS_QUERY = `
query ($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        body
        url
        createdAt
        author {
          login
        }
        category {
          name
        }
      }
    }
  }
}
`;

/**
 * 신규 판별 기준 시각(cutoff)을 정한다.
 *  - 마커가 있고 시각으로 해석되면 그 시각 (fromMarker: true)
 *  - 마커가 없거나(첫 실행/캐시 소실) 내용이 손상됐으면 now - lookbackMinutes로 폴백
 *    → 과거 글 폭주(전체 알림)와 조용한 실패(영구 중단)를 모두 방지하는 자가 복구
 * @param {{markerTimestamp: string|null, lookbackMinutes: number, now?: Date}} params
 * @returns {{cutoff: Date, fromMarker: boolean}}
 */
export function resolvePollCutoff({ markerTimestamp, lookbackMinutes, now = new Date() }) {
  const fallback = new Date(now.getTime() - lookbackMinutes * 60_000);
  const trimmed = (markerTimestamp ?? '').trim();
  if (!trimmed) return { cutoff: fallback, fromMarker: false };

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return { cutoff: fallback, fromMarker: false };
  return { cutoff: parsed, fromMarker: true };
}

/**
 * cutoff 이후(초과, 경계 제외)에 생성된 디스커션만 남기고 오래된 순으로 정렬한다.
 * 마커가 "마지막으로 확인한 글의 createdAt"으로 갱신되므로, 경계값을 포함하면
 * 같은 글이 다음 실행에서 중복 알림된다 — 그래서 엄격 초과 비교를 쓴다.
 * @param {Array<{createdAt: string}>} discussions
 * @param {Date} cutoff
 * @returns {Array<object>} 오래된 순 (디스코드에 시간순으로 전송하기 위함)
 */
export function filterNewDiscussions(discussions, cutoff) {
  const cutoffMs = cutoff.getTime();
  return discussions
    .filter((d) => new Date(d.createdAt).getTime() > cutoffMs)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * 다음 실행에서 쓸 마커 시각. 조회된 글 중 가장 최신 createdAt과 cutoff 중 큰 값이다.
 * 로컬 시계(now) 대신 GitHub의 createdAt을 쓰므로 시계 오차·조회 지연으로 인한 누락이 없다.
 * 신규 글이 없으면 cutoff가 유지된다 (글이 없으면 중복 위험도 없으므로 문제 없음).
 * @param {Array<{createdAt: string}>} discussions
 * @param {Date} cutoff
 * @returns {string} ISO 8601 문자열
 */
export function nextMarkerTimestamp(discussions, cutoff) {
  let maxMs = cutoff.getTime();
  for (const discussion of discussions) {
    const createdMs = new Date(discussion.createdAt).getTime();
    if (Number.isFinite(createdMs) && createdMs > maxMs) maxMs = createdMs;
  }
  return new Date(maxMs).toISOString();
}

/**
 * POLL_LOOKBACK_MINUTES 파싱. 비어 있으면 기본값, 양수가 아니면 명시적 예외.
 * @param {string|undefined} raw
 * @param {number} defaultMinutes
 * @returns {number}
 */
export function parseLookbackMinutes(raw, defaultMinutes = DEFAULT_LOOKBACK_MINUTES) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return defaultMinutes;

  const minutes = Number(trimmed);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      `POLL_LOOKBACK_MINUTES 값이 올바르지 않습니다: "${raw}" (양수 분 단위 숫자여야 함)`,
    );
  }
  return minutes;
}

/**
 * 최신순으로 디스커션을 조회한다. 페이지의 가장 오래된 글이 cutoff 이전이면 중단하므로
 * 결과에 cutoff 이전 글이 일부 섞일 수 있다 — 반드시 filterNewDiscussions로 걸러 쓴다.
 * @param {{owner: string, name: string, token: string, cutoff: Date, fetchImpl?: typeof fetch, graphqlUrl?: string}} params
 * @returns {Promise<Array<object>>}
 */
export async function fetchDiscussionsSince({
  owner,
  name,
  token,
  cutoff,
  fetchImpl = fetch,
  // Actions가 자동 주입하는 GITHUB_GRAPHQL_URL을 따른다 (GHES·테스트 환경 대응)
  graphqlUrl = process.env.GITHUB_GRAPHQL_URL || DEFAULT_GRAPHQL_URL,
}) {
  const discussions = [];
  let cursor = null;

  for (;;) {
    const response = await fetchImpl(graphqlUrl, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ktb-mentoring-noti',
      },
      body: JSON.stringify({
        query: RECENT_DISCUSSIONS_QUERY,
        variables: { owner, name, cursor },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub GraphQL 요청 실패: HTTP ${response.status} ${body}`.trim());
    }

    const result = await response.json();
    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL 오류: ${JSON.stringify(result.errors)}`);
    }

    const connection = result.data?.repository?.discussions;
    if (!connection) {
      throw new Error(
        `디스커션 조회 결과가 비어 있습니다. 레포(${owner}/${name}) 접근 권한과 Discussions 활성화 여부를 확인하세요.`,
      );
    }

    discussions.push(...connection.nodes);

    // DESC 정렬이므로 페이지의 마지막 노드가 가장 오래된 글 — cutoff 이전이면 조회 종료
    const oldest = connection.nodes.at(-1);
    const reachedCutoff = oldest && new Date(oldest.createdAt).getTime() <= cutoff.getTime();
    if (reachedCutoff || !connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return discussions;
}

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
  const token = requireEnv('GITHUB_TOKEN');
  const repository = requireEnv('GITHUB_REPOSITORY'); // "owner/name" — Actions가 자동 주입
  const [owner, name] = repository.split('/');
  if (!owner || !name) {
    throw new Error(`GITHUB_REPOSITORY 형식이 잘못되었습니다: "${repository}" (owner/name 형식이어야 함)`);
  }

  const categoryFilter = parseList(process.env.DISCUSSION_CATEGORIES);
  const mentorMapping = loadMentorMappingFromEnv();
  const markerFile = (process.env.MARKER_FILE ?? '').trim() || DEFAULT_MARKER_FILE;
  const lookbackMinutes = parseLookbackMinutes(process.env.POLL_LOOKBACK_MINUTES);

  const markerTimestamp = await readMarker(markerFile);
  const { cutoff, fromMarker } = resolvePollCutoff({ markerTimestamp, lookbackMinutes });
  if (!markerTimestamp) {
    console.log(
      `마커 파일(${markerFile}) 없음(첫 실행 또는 캐시 소실) — 최근 ${lookbackMinutes}분 내 글만 확인합니다.`,
    );
  } else if (!fromMarker) {
    console.warn(
      `경고: 마커 파일(${markerFile}) 내용("${markerTimestamp.trim()}")이 시각이 아닙니다 — 최근 ${lookbackMinutes}분으로 폴백합니다.`,
    );
  }

  const fetched = await fetchDiscussionsSince({ owner, name, token, cutoff });
  const newOnes = filterNewDiscussions(fetched, cutoff);
  console.log(`기준 시각 ${cutoff.toISOString()} 이후 신규 디스커션 ${newOnes.length}건`);

  for (const discussion of newOnes) {
    const categoryName = discussion.category?.name ?? '(카테고리 없음)';
    if (!matchesCategory(categoryName, categoryFilter)) {
      console.log(`#${discussion.number} 카테고리 "${categoryName}"는 알림 대상이 아니므로 건너뜁니다.`);
      continue;
    }

    const desired = parseDesiredMentor({ title: discussion.title, body: discussion.body });
    const mentorHandle = desired?.handle ?? desired?.githubLogin ?? null;
    // 새 글 알림과 동일: 지정 멘토가 매핑돼 있으면 @멘션(화이트리스트로 인젝션 방지).
    const mentorDiscordId = mentorHandle ? findMentorDiscordId(mentorMapping, mentorHandle) : null;
    const mentorDiscordUsername = mentorHandle
      ? findMentorDiscordUsername(mentorMapping, mentorHandle)
      : null;
    const allowedUserIds = isDiscordUserId(mentorDiscordId) ? [mentorDiscordId] : [];

    const message = buildNewDiscussionMessage({
      title: discussion.title,
      url: discussion.url,
      author: discussion.author?.login ?? '(알 수 없음)',
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

  // 마커는 전송이 모두 끝난 뒤에만 갱신한다. 중간에 실패하면 마커가 그대로 남아
  // 다음 실행에서 재시도된다 (일부 중복 알림 가능 — 누락보다 안전한 fail-safe).
  const nextMarker = nextMarkerTimestamp(fetched, cutoff);
  await writeFile(markerFile, `${nextMarker}\n`, 'utf8');
  console.log(`마커 갱신: ${markerFile} → ${nextMarker}`);
}

/** 마커 파일을 읽는다. 없으면 null (첫 실행/캐시 소실), 그 외 오류는 그대로 전파. */
async function readMarker(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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

// 테스트가 순수 함수를 import할 때 main이 실행되지 않도록, 직접 실행된 경우에만 구동한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
