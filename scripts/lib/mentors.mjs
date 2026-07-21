// "답변 희망 멘토" 표기 파싱과 멘토 깃헙 계정 매핑
//
// 지원하는 표기 관례:
//  - 제목: "... (답변희망멘토: mentor.one)" / "(답변 희망 멘토 : mentor.two)" — 띄어쓰기 제각각
//  - 본문: "🙋답변 희망 멘토" 섹션에 "사내핸들(이름)/@깃헙핸들" 형태 — @깃헙핸들이 있으면 추출 가능
//  - 단, 표기 과정에서 깃헙 핸들·사내 핸들에 오타가 생길 수 있으므로
//    멘토 매핑(사내 핸들 → 깃헙 로그인)을 1순위로 쓴다.
//    매핑은 Actions Secret MENTORS_JSON(JSON 문자열)로 주입하며, 없으면 mentors.json 파일 폴백
//    (mentors.json은 퍼블릭 소스 레포에 배포하지 않는다).

import { existsSync, readFileSync } from 'node:fs';

const TITLE_MENTOR_RE = /답변\s*희망\s*멘토\s*[:：]\s*([^)\]）】\n]+)/;
// @ 바로 앞이 단어문자/`.`이면 이메일(name@corp.com)이므로 배제. '/@handle' 표기는 허용.
const GITHUB_HANDLE_RE = /(?:^|[^\w@.])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/;
// 사내 핸들(xxx.yyy)은 각 세그먼트에 영문자가 최소 1개 있어야 함 — 버전 번호(3.2) 오인 방지.
const INTERNAL_HANDLE_RE =
  /(?<![a-z0-9.])[a-z0-9]*[a-z][a-z0-9]*\.[a-z0-9]*[a-z][a-z0-9]*(?![a-z0-9.])/i;
const SECTION_MARKER_RE = /^\s*(?:#{1,6}\s|🙋|✏️|👀|⏭|❓|📌)/u;

/**
 * 제목/본문에서 답변 희망 멘토 표기를 추출한다.
 * 제목 캡처는 "mentor.one(이름)" 같은 병기 때문에 그대로 쓰지 않고 핸들 토큰만 재추출한다.
 * 본문은 질문 내용의 @어노테이션·이메일·버전 번호를 멘토로 오인하지 않도록
 * "답변 희망 멘토" 표기 줄(+바로 다음 줄)로만 스캔을 한정한다.
 * @param {{title?: string, body?: string}} discussion
 * @returns {{handle: string|null, githubLogin: string|null}|null} 표기가 전혀 없으면 null
 */
export function parseDesiredMentor(discussion) {
  const { title, body } = discussion;

  const rawTitle = (title ?? '').match(TITLE_MENTOR_RE)?.[1] ?? null;
  let handle = rawTitle?.match(INTERNAL_HANDLE_RE)?.[0] ?? null;
  let githubLogin = rawTitle?.match(GITHUB_HANDLE_RE)?.[1] ?? null;

  const section = mentorSectionText(body);
  if (section) {
    githubLogin ??= section.match(GITHUB_HANDLE_RE)?.[1] ?? null;
    handle ??= section.match(INTERNAL_HANDLE_RE)?.[0] ?? null;
  }

  if (!handle && !githubLogin) return null;
  return { handle: handle ? handle.toLowerCase() : null, githubLogin };
}

/**
 * 표시·그룹핑용 멘토 로그인 해석.
 * 1순위: mentors.json 매핑(오타·핸들 미기재를 흡수), 2순위: 본문/제목에 적힌 @깃헙핸들.
 * @param {{handle: string|null, githubLogin: string|null}|null} desired
 * @param {Record<string, string>} mapping 사내 핸들(소문자) → 깃헙 로그인
 * @returns {string|null}
 */
export function resolveMentorLogin(desired, mapping = {}) {
  if (!desired) return null;
  if (desired.handle && Object.hasOwn(mapping, desired.handle)) return mapping[desired.handle];
  return desired.githubLogin;
}

/**
 * 판정(REQUIRE_ASSIGNED_MENTOR_ANSWER)용 멘토 로그인 해석 — 검증된 값만 반환한다.
 * 학생이 잘못 적은 @핸들이 판정 기준이 되면 멘토가 답변해도 영구 리마인드되므로,
 * 매핑에서 해석되었거나 매핑의 값 목록에 존재하는 로그인만 인정한다. 그 외에는 null을
 * 반환해 기본 판정(작성자 외 코멘트)으로 폴백시킨다.
 * @param {{handle: string|null, githubLogin: string|null}|null} desired
 * @param {Record<string, string>} mapping
 * @returns {string|null}
 */
export function resolveJudgmentLogin(desired, mapping = {}) {
  if (!desired) return null;
  if (desired.handle && Object.hasOwn(mapping, desired.handle)) return mapping[desired.handle];
  if (desired.githubLogin) {
    const target = desired.githubLogin.toLowerCase();
    if (Object.values(mapping).some((login) => login.toLowerCase() === target)) {
      return desired.githubLogin;
    }
  }
  return null;
}

/**
 * 깃헙 로그인 → 사내 핸들 역조회 (대소문자 무시).
 * 코멘트 작성자가 멘토인지 판별하고, 알림에 사내 핸들을 병기하기 위한 용도.
 * 같은 로그인이 여러 핸들에 매핑되어 있으면(오타 변형 병기 등) 먼저 나오는 핸들을 쓴다.
 * @param {Record<string, string>} mapping 사내 핸들(소문자) → 깃헙 로그인
 * @param {string|null|undefined} login
 * @returns {string|null} 매핑에 없으면(멘토가 아니면) null
 */
export function findMentorHandleByLogin(mapping, login) {
  if (!login) return null;
  const target = login.toLowerCase();
  for (const [handle, mappedLogin] of Object.entries(mapping)) {
    if (mappedLogin.toLowerCase() === target) return handle;
  }
  return null;
}

// MENTORS_FILE 미지정 시 폴백으로 읽는 매핑 파일 경로 (레포 루트 기준)
const DEFAULT_MENTORS_FILE = 'mentors.json';

/**
 * 파싱된 JSON 값을 멘토 매핑으로 검증·정규화한다 (파일/환경변수/속성 경로 공용).
 * 형식이 잘못됐으면 설정 오류이므로 명시적으로 실패시킨다 — silent fail 금지.
 * @param {unknown} parsed JSON.parse 결과
 * @param {string} sourceLabel 오류 메시지에 표시할 출처 라벨 (예: `멘토 매핑 파일(mentors.json)`)
 * @param {{redactKeys?: boolean}} [options] redactKeys: 출처가 Secret이면 키(사내 핸들)도
 *   Secret의 일부이므로 오류 메시지에 싣지 않고 몇 번째 키인지로만 안내한다
 *   (퍼블릭 Actions 로그 유출 방지 — Actions Secret 마스킹은 값 전체 일치만 가린다).
 * @returns {Record<string, string>} 사내 핸들(소문자) → 깃헙 로그인 (null 프로토타입)
 */
export function parseMentorMapping(parsed, sourceLabel = '멘토 매핑', { redactKeys = false } = {}) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourceLabel}은(는) {"사내핸들": "깃헙로그인"} 객체여야 합니다.`);
  }

  // '__proto__' 같은 키가 프로토타입을 오염시키지 않도록 null 프로토타입 객체를 쓴다.
  const mapping = Object.create(null);
  for (const [index, [handle, login]] of Object.entries(parsed).entries()) {
    if (typeof login !== 'string' || !login.trim()) {
      const keyRef = redactKeys ? `${index + 1}번째 키` : `"${handle}"`;
      throw new Error(`${sourceLabel}의 ${keyRef} 값이 올바른 깃헙 로그인이 아닙니다.`);
    }
    mapping[handle.trim().toLowerCase()] = login.trim();
  }
  return mapping;
}

/**
 * mentors.json을 읽는다. 파일이 없으면 빈 매핑(기능 자동 비활성).
 * 파일이 있는데 형식이 잘못됐으면 설정 오류이므로 명시적으로 실패시킨다.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function loadMentorMapping(filePath) {
  if (!existsSync(filePath)) return Object.create(null);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`멘토 매핑 파일(${filePath}) JSON 파싱 실패: ${error.message}`);
  }
  return parseMentorMapping(parsed, `멘토 매핑 파일(${filePath})`);
}

/**
 * 환경변수 우선으로 멘토 매핑을 로드한다. 우선순위:
 *   1. env.MENTORS_JSON — 매핑 JSON 문자열 (Actions Secret으로 주입. mentors.json은
 *      퍼블릭 소스 레포에 배포하지 않으므로 이 경로를 기본으로 사용)
 *   2. (폴백) env.MENTORS_FILE(공백뿐이면 미설정 취급) 또는 'mentors.json' 파일 — 기존 방식과의 하위호환
 *   3. 둘 다 없으면 빈 매핑 (멘토 추적 기능 자동 비활성)
 *
 * Actions는 미설정 Secret을 빈 문자열로 주입하므로 공백뿐인 MENTORS_JSON은 미설정으로 본다.
 * MENTORS_JSON이 있는데 형식이 잘못됐으면 설정 오류이므로 명시적으로 실패시킨다.
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Record<string, string>} 사내 핸들(소문자) → 깃헙 로그인 (null 프로토타입)
 */
export function loadMentorMappingFromEnv({ env = process.env } = {}) {
  const raw = (env.MENTORS_JSON ?? '').trim();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Node 20+(V8)의 JSON.parse 오류 메시지는 원문 일부를 그대로 인용할 수 있다
      // (예: Unexpected token 'S', ..."원문 조각"... is not valid JSON).
      // MENTORS_JSON은 Secret이고 이 예외는 퍼블릭 레포의 Actions 로그에 남으므로,
      // 원문이 섞이지 않도록 위치 정보만 추려 다시 던진다
      // (Actions의 Secret 마스킹은 값 전체 일치만 가리므로 조각 인용은 마스킹되지 않는다).
      const position =
        error.message?.match(/at position \d+(?: \(line \d+ column \d+\))?/)?.[0] ?? null;
      throw new Error(
        `MENTORS_JSON 환경변수(Secret) JSON 파싱 실패${position ? ` (${position})` : ''} — ` +
          'Secret 값이 로그에 남지 않도록 상세 메시지는 생략합니다. JSON 문법을 확인해 다시 등록하세요.',
      );
    }
    return parseMentorMapping(parsed, 'MENTORS_JSON 환경변수(Secret)', { redactKeys: true });
  }
  return loadMentorMapping(mentorsFilePathFromEnv(env));
}

/**
 * 현재 환경에서 멘토 매핑이 어느 출처에서 로드되는지 사람이 읽을 라벨.
 * 엔트리 스크립트의 "매핑 없음" 안내 로그가 출처(Secret/파일)를 구분해 남기기 위한 용도로,
 * loadMentorMappingFromEnv와 동일한 우선순위 판단을 쓴다.
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export function mentorMappingSourceLabel({ env = process.env } = {}) {
  if ((env.MENTORS_JSON ?? '').trim()) return 'Secret(MENTORS_JSON)';
  return `파일(${mentorsFilePathFromEnv(env)}) — Secret(MENTORS_JSON) 미설정`;
}

/**
 * 폴백 파일 경로 해석 — 공백뿐인 MENTORS_FILE은 미설정으로 취급한다
 * (MENTORS_JSON의 공백 처리와 동일 기준: 빈 env 주입을 "설정됨"으로 오인하지 않는다).
 * loadMentorMappingFromEnv/mentorMappingSourceLabel이 같은 판단을 공유한다.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function mentorsFilePathFromEnv(env) {
  return (env.MENTORS_FILE ?? '').trim() || DEFAULT_MENTORS_FILE;
}

/**
 * 본문에서 "답변 희망 멘토" 표기 줄과 바로 다음 내용 줄만 잘라낸다.
 * (다음 줄이 새 섹션 헤더면 제외 — 멘토 표기가 비어 있는 템플릿 대응)
 */
function mentorSectionText(body) {
  const index = (body ?? '').search(/답변\s*희망\s*멘토/);
  if (index === -1) return null;

  const lines = body.slice(index).split('\n');
  const scanLines = [lines[0]];
  const nextLine = lines.slice(1).find((line) => line.trim());
  if (nextLine && !SECTION_MARKER_RE.test(nextLine)) scanLines.push(nextLine);
  return scanLines.join('\n');
}
