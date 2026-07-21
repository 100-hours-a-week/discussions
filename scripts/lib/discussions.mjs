// GitHub Discussions 조회 및 미답변 판정

const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';

// 이 라벨이 붙어 있으면 답변 완료로 간주 (환경변수 ANSWERED_LABELS로 재정의 가능)
export const DEFAULT_ANSWERED_LABELS = ['answered', '답변완료', '답변 완료'];

// comments/replies는 last(최신 우선)로 조회한다. 이 커넥션은 오래된 순으로만 반환되는데,
// 멘토의 답변은 최신 쪽에 달리므로 first로 자르면 정확히 답변 쪽이 잘려나간다.
export const DISCUSSIONS_QUERY = `
query ($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
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
        closed
        isAnswered
        author {
          login
        }
        category {
          name
          isAnswerable
        }
        labels(first: 20) {
          nodes {
            name
          }
        }
        comments(last: 50) {
          totalCount
          nodes {
            author {
              login
            }
            replies(last: 20) {
              totalCount
              nodes {
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

/**
 * 레포의 모든 디스커션을 페이지네이션으로 조회한다.
 * @param {{owner: string, name: string, token: string, fetchImpl?: typeof fetch, graphqlUrl?: string}} params
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllDiscussions({
  owner,
  name,
  token,
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
        query: DISCUSSIONS_QUERY,
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
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return discussions;
}

/**
 * 미답변 판정. 아래 중 하나라도 해당하면 "답변됨"으로 보고 제외한다.
 *  - closed 상태
 *  - Mark as answer 처리됨 (isAnswered)
 *  - 답변 완료 라벨 부착
 *  - 작성자 외 다른 사람의 코멘트(대댓글 포함) 존재
 *    (requiredAnswererLogin이 지정되면 "그 사람의 코멘트 존재"로 강화)
 * @param {object} discussion GraphQL 노드
 * @param {{answeredLabels?: string[], requiredAnswererLogin?: string|null}} options
 * @returns {boolean}
 */
export function isUnanswered(discussion, options = {}) {
  const { answeredLabels = DEFAULT_ANSWERED_LABELS, requiredAnswererLogin = null } = options;

  if (discussion.closed) return false;
  if (discussion.isAnswered === true) return false;

  const normalizedAnswered = answeredLabels.map((label) => label.trim().toLowerCase());
  const labels = (discussion.labels?.nodes ?? []).map((label) => label.name.toLowerCase());
  if (labels.some((label) => normalizedAnswered.includes(label))) return false;

  // 지정 멘토가 글 작성자 본인으로 해석됐다면 파싱 오류 신호다(멘토는 질문 작성자일 수 없음).
  // 그대로 쓰면 작성자의 셀프 코멘트만으로 완료 처리되므로 기본 판정으로 폴백한다.
  if (
    requiredAnswererLogin &&
    requiredAnswererLogin.toLowerCase() !== (discussion.author?.login ?? '').toLowerCase()
  ) {
    return !hasCommentBy(discussion, requiredAnswererLogin);
  }

  // 작성자가 탈퇴 계정(author null)이면 코멘트 작성자와 동일인인지 판별할 수 없다.
  // null끼리 비교되면 동일인 취급되어 리마인드가 유지되는데, 이는 의도된 fail-safe다
  // (판별 불가 시 리마인드 누락보다 중복 리마인드가 안전. closed/라벨로 수동 제외 가능).
  const authorLogin = discussion.author?.login ?? null;
  const commentAuthors = collectCommentAuthors(discussion);
  if (commentAuthors.some((login) => login !== authorLogin)) return false;

  return true;
}

/**
 * 특정 깃헙 로그인이 코멘트(대댓글 포함)를 남겼는지. 로그인 비교는 대소문자 무시.
 * @param {object} discussion GraphQL 노드
 * @param {string|null} login
 */
export function hasCommentBy(discussion, login) {
  if (!login) return false;
  const target = login.toLowerCase();
  return collectCommentAuthors(discussion).some(
    (author) => author !== null && author.toLowerCase() === target,
  );
}

/**
 * comments/replies가 조회 한도(last: N)를 넘어 일부만 판정에 사용됐는지 여부.
 * 잘렸어도 판정은 fail-safe(미답변 유지)로 동작하므로, 호출부에서 경고 로그 용도로 쓴다.
 */
export function hasTruncatedComments(discussion) {
  const comments = discussion.comments;
  if ((comments?.totalCount ?? 0) > (comments?.nodes?.length ?? 0)) return true;
  return (comments?.nodes ?? []).some(
    (comment) => (comment.replies?.totalCount ?? 0) > (comment.replies?.nodes?.length ?? 0),
  );
}

/**
 * 카테고리 이름이 필터에 부합하는지. 필터가 비어 있으면 항상 통과.
 * @param {string|undefined} categoryName
 * @param {string[]|undefined} categories
 */
export function matchesCategory(categoryName, categories) {
  const normalized = (categories ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return true;
  return normalized.includes((categoryName ?? '').toLowerCase());
}

/**
 * 카테고리 이름으로 필터링한다. categories가 비어 있으면 전체 통과.
 * @param {Array<object>} discussions
 * @param {string[]} categories
 */
export function filterByCategories(discussions, categories) {
  return discussions.filter((d) => matchesCategory(d.category?.name, categories));
}

/**
 * 기준일 이후에 작성된 디스커션만 남긴다. since가 비어 있으면 전체 통과.
 * 소스 레포에 이전 기수 글이 쌓여 있으므로, 기수 시작일로 잘라내는 용도.
 * @param {Array<object>} discussions
 * @param {string} [since] ISO 날짜 문자열 (예: "2026-07-01" 또는 "2026-07-01T00:00:00+09:00")
 */
export function filterByCreatedSince(discussions, since) {
  if (!since || !since.trim()) return discussions;
  const cutoff = new Date(since);
  if (Number.isNaN(cutoff.getTime())) {
    throw new Error(`REMIND_SINCE 날짜 형식이 잘못되었습니다: "${since}" (예: 2026-07-01)`);
  }
  return discussions.filter((d) => new Date(d.createdAt).getTime() >= cutoff.getTime());
}

/**
 * GraphQL 노드를 메시지 빌더 입력 형태로 변환한다.
 */
export function toReminderItem(discussion) {
  return {
    title: discussion.title,
    url: discussion.url,
    author: discussion.author?.login ?? '(알 수 없음)',
    category: discussion.category?.name ?? '(카테고리 없음)',
    labels: (discussion.labels?.nodes ?? []).map((label) => label.name),
  };
}

function collectCommentAuthors(discussion) {
  const authors = [];
  for (const comment of discussion.comments?.nodes ?? []) {
    authors.push(comment.author?.login ?? null);
    for (const reply of comment.replies?.nodes ?? []) {
      authors.push(reply.author?.login ?? null);
    }
  }
  return authors;
}
