// "답변 희망 멘토" 표기 파싱과 멘토 매핑(깃헙 계정 · 디스코드 계정)
//
// 지원하는 표기 관례:
//  - 제목: "... (답변희망멘토: mentor.one)" / "(답변 희망 멘토 : mentor.two)" — 띄어쓰기 제각각
//         "멘토"는 선택이라 "(답변 희망: mentor.three)"처럼 멘토 없이도 인식한다(콜론은 필수).
//  - 본문: "🙋답변 희망 멘토" / "🙋답변 희망" 섹션에 "사내핸들(이름)/@깃헙핸들" 형태 — @깃헙핸들이 있으면 추출 가능
//  - 단, 표기 과정에서 깃헙 핸들·사내 핸들에 오타가 생길 수 있으므로
//    멘토 매핑(사내 핸들 → 멘토 정보)을 1순위로 쓴다.
//    매핑은 Actions Secret MENTORS_JSON(JSON 문자열)로 주입하며, 없으면 mentors.json 파일 폴백
//    (mentors.json은 퍼블릭 소스 레포에 배포하지 않는다).
//
// 매핑 스키마 (mentors.json / MENTORS_JSON):
//   {
//     "max.cha": {
//       "github": "Coreight98",              // 선택 — 깃헙 로그인. 없거나 null이면 "표시·멘션 전용" 멘토
//                                            //        (판정에서 제외돼 기본 판정으로 폴백, 표시·멘션·그룹핑은 유지)
//       "discord": "123456789012345678",     // 선택 — 멘션용 숫자 ID(17~20자리 문자열). 없으면 null
//       "discordUsername": "cajaemyeong",    // 선택 — 참고·해석용 유저네임. 없으면 null
//       "aliases": ["max.chaa"]              // 선택 — 같은 멘토를 가리키는 별칭 키(오타 흡수용)
//     },
//     "grey.great": { "aliasOf": "gray.great" },  // 별칭 전용 항목(위 aliases와 등가, 방향만 반대)
//     "charlotte.chk": "cohys7"              // 하위호환 — 문자열이면 {github: 값}으로 정규화(빈 문자열이면 github: null)
//   }
// 정규화 후 각 값은 항상 {github, discord, discordUsername} 형태(동결 객체)이며,
// 별칭 키는 원 핸들과 **동일한 엔트리 객체**를 가리킨다(디스코드 정보까지 함께 공유).
//
// ⚠️ 디스코드 "아이디"로 유저네임(예: anyongjun97)을 넣으면 멘션이 동작하지 않으므로
//    discord 값은 숫자 ID인지 검증하고, 아니면 명시적으로 실패시킨다 (silent fail 금지).

import { existsSync, readFileSync } from 'node:fs';

// "멘토"는 선택 — 제목 표기 "답변 희망:"과 "답변 희망 멘토:" 둘 다 인식한다.
// 콜론(: 또는 ：)은 필수로 유지한다 — 문장 속 "답변 희망"(콜론 없음)이 오매칭되지 않도록.
const TITLE_MENTOR_RE = /답변\s*희망(?:\s*멘토)?\s*[:：]\s*([^)\]）】\n]+)/;
// @ 바로 앞이 단어문자/`.`이면 이메일(name@corp.com)이므로 배제. '/@handle' 표기는 허용.
const GITHUB_HANDLE_RE = /(?:^|[^\w@.])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/;
// 사내 핸들(xxx.yyy)은 각 세그먼트에 영문자가 최소 1개 있어야 함 — 버전 번호(3.2) 오인 방지.
const INTERNAL_HANDLE_RE =
  /(?<![a-z0-9.])[a-z0-9]*[a-z][a-z0-9]*\.[a-z0-9]*[a-z][a-z0-9]*(?![a-z0-9.])/i;
const SECTION_MARKER_RE = /^\s*(?:#{1,6}\s|🙋|✏️|👀|⏭|❓|📌)/u;
// 본문 "답변 희망(멘토)" 섹션 헤더 판별 — 줄머리(선택적 마커·공백 뒤)에서 시작할 때만 섹션으로 본다.
// "멘토"를 선택으로 완화하면 "답변 희망"이 흔한 표현이라 오탐이 커진다 — 질문 본문 문장 속
// "빠른 답변 희망합니다"(뒤에 붙은 dot 토큰·다음 줄 핸들까지) 오인을 막기 위해 줄머리 앵커로 헤더만 잡는다.
// 실데이터(3기)는 헤더를 마크다운 볼드로 감싼다("🙋 **답변 희망 멘토**", "## **🙋답변 희망 멘토**").
// 마커 앞뒤의 `*`·`_`·공백을 건너뛰지 않으면 본문 @핸들을 통째로 놓치므로([*_\s]*) 허용한다
// (줄머리 앵커·"답변" 시작 요구·핸들 존재 가드는 그대로라 문장 속 "답변 희망"은 여전히 미매칭).
const DESIRED_HEADER_RE = /^\s*(?:#{1,6}\s*)?[*_\s]*(?:🙋|✏️|👀|⏭|❓|📌)?[*_\s]*답변\s*희망(?:\s*멘토)?/u;
// 디스코드 스노우플레이크 ID — 현재 17~19자리이며 여유를 둬 20자리까지 허용한다.
const DISCORD_ID_RE = /^\d{17,20}$/;

/**
 * @typedef {{github: string|null, discord: string|null, discordUsername: string|null}} MentorEntry
 */

/**
 * 제목/본문에서 답변 희망 멘토 표기를 추출한다.
 * 제목 캡처는 "mentor.one(이름)" 같은 병기 때문에 그대로 쓰지 않고 핸들 토큰만 재추출한다.
 * 본문은 질문 내용의 @어노테이션·이메일·버전 번호를 멘토로 오인하지 않도록
 * "답변 희망(멘토)" 헤더 줄(+바로 다음 줄)로만 스캔을 한정한다("멘토" 선택 완화 후에도 줄머리 앵커 유지).
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
 * 1순위: 멘토 매핑(오타·핸들 미기재를 흡수), 2순위: 본문/제목에 적힌 @깃헙핸들.
 * 핸들이 매핑에 있으면 매핑이 권위 있다 — 그 멘토의 github가 null("표시·멘션 전용" 멘토)이면
 * 학생이 적은 @핸들로 폴백하지 않고 null을 반환한다(그룹핑·멘션은 사내 핸들로 별도 처리하므로
 * github 로그인이 없어도 표시·핑에는 지장이 없다).
 * @param {{handle: string|null, githubLogin: string|null}|null} desired
 * @param {Record<string, MentorEntry|string>} mapping 사내 핸들(소문자) → 멘토 엔트리(또는 구 스키마 문자열)
 * @returns {string|null}
 */
export function resolveMentorLogin(desired, mapping = {}) {
  if (!desired) return null;
  if (desired.handle && Object.hasOwn(mapping, desired.handle)) {
    // 알려진 멘토면 매핑의 github가 최종값 — null이면(판정 제외 멘토) 그대로 null을 돌려준다.
    return githubOf(mapping[desired.handle]);
  }
  return desired.githubLogin;
}

/**
 * 판정(REQUIRE_ASSIGNED_MENTOR_ANSWER)용 멘토 로그인 해석 — 검증된 값만 반환한다.
 * 학생이 잘못 적은 @핸들이 판정 기준이 되면 멘토가 답변해도 영구 리마인드되므로,
 * 매핑에서 해석되었거나 매핑의 깃헙 로그인 목록에 존재하는 로그인만 인정한다. 그 외에는 null을
 * 반환해 기본 판정(작성자 외 코멘트)으로 폴백시킨다.
 * 핸들이 매핑에 있으면 매핑이 권위 있다 — 그 멘토의 github가 null("표시·멘션 전용" 멘토)이면
 * 판정 대상이 없다는 뜻이므로 null을 반환해 기본 판정으로 폴백시킨다.
 * @param {{handle: string|null, githubLogin: string|null}|null} desired
 * @param {Record<string, MentorEntry|string>} mapping
 * @returns {string|null}
 */
export function resolveJudgmentLogin(desired, mapping = {}) {
  if (!desired) return null;
  // 핸들이 매핑에 있으면 그 멘토의 github가 최종값 — null이면 판정 제외(기본 판정 폴백).
  if (desired.handle && Object.hasOwn(mapping, desired.handle)) {
    return githubOf(mapping[desired.handle]);
  }
  // 핸들이 매핑에 없을 때만, 학생이 적은 @핸들이 매핑의 알려진 github와 일치하면 인정한다.
  if (desired.githubLogin) {
    const target = desired.githubLogin.toLowerCase();
    const known = Object.values(mapping).some((entry) => githubOf(entry)?.toLowerCase() === target);
    if (known) return desired.githubLogin;
  }
  return null;
}

/**
 * 깃헙 로그인 → 사내 핸들 역조회 (대소문자 무시).
 * 코멘트 작성자가 멘토인지 판별하고, 알림에 사내 핸들을 병기하기 위한 용도.
 * 같은 로그인이 여러 핸들에 매핑되어 있으면(별칭 등) 먼저 나오는 핸들을 쓴다.
 * github가 null인 멘토("표시·멘션 전용")는 어떤 로그인과도 매칭시키지 않는다
 * — null == login 오매칭이 없도록 명시 guard를 둔다(코멘트 작성자를 그 멘토로 오인하지 않도록).
 * @param {Record<string, MentorEntry|string>} mapping
 * @param {string|null|undefined} login
 * @returns {string|null} 매핑에 없으면(멘토가 아니면) null
 */
export function findMentorHandleByLogin(mapping, login) {
  if (!login) return null;
  const target = login.toLowerCase();
  for (const [handle, entry] of Object.entries(mapping)) {
    const github = githubOf(entry);
    if (github !== null && github.toLowerCase() === target) return handle;
  }
  return null;
}

/**
 * 사내 핸들 또는 깃헙 로그인으로 멘토 엔트리를 조회한다 (둘 다 대소문자 무시).
 * 핸들 조회를 먼저 하고, 없으면 깃헙 로그인으로 역조회한다.
 * 구 스키마(문자열 값)도 {github, discord: null, discordUsername: null}로 정규화해 돌려준다.
 * @param {Record<string, MentorEntry|string>} mapping
 * @param {string|null|undefined} handleOrLogin
 * @returns {MentorEntry|null} 매핑에 없으면 null
 */
export function findMentorEntry(mapping, handleOrLogin) {
  if (!handleOrLogin || typeof handleOrLogin !== 'string') return null;
  const key = handleOrLogin.trim().toLowerCase();
  if (!key) return null;

  if (Object.hasOwn(mapping, key)) return toMentorEntry(mapping[key]);
  for (const entry of Object.values(mapping)) {
    if (githubOf(entry)?.toLowerCase() === key) return toMentorEntry(entry);
  }
  return null;
}

/**
 * 멘션용 디스코드 숫자 ID 조회 (사내 핸들 또는 깃헙 로그인으로).
 * 멘토가 아니거나 디스코드 정보가 없으면 null — 호출부는 멘션 없이 진행해야 한다.
 * @param {Record<string, MentorEntry|string>} mapping
 * @param {string|null|undefined} handleOrLogin
 * @returns {string|null}
 */
export function findMentorDiscordId(mapping, handleOrLogin) {
  return findMentorEntry(mapping, handleOrLogin)?.discord ?? null;
}

/**
 * 참고·해석용 디스코드 유저네임 조회 (멘션 불가 — 표시·대조용).
 * @param {Record<string, MentorEntry|string>} mapping
 * @param {string|null|undefined} handleOrLogin
 * @returns {string|null}
 */
export function findMentorDiscordUsername(mapping, handleOrLogin) {
  return findMentorEntry(mapping, handleOrLogin)?.discordUsername ?? null;
}

// MENTORS_FILE 미지정 시 폴백으로 읽는 매핑 파일 경로 (레포 루트 기준)
const DEFAULT_MENTORS_FILE = 'mentors.json';

/**
 * 파싱된 JSON 값을 멘토 매핑으로 검증·정규화한다 (파일/환경변수/속성 경로 공용).
 * 형식이 잘못됐으면 설정 오류이므로 명시적으로 실패시킨다 — silent fail 금지.
 *
 * github는 선택 필드다 — 없거나 null/빈 문자열이면 github: null로 정규화한다
 * (github: null인 멘토는 "표시·멘션 전용"으로 판정에서 제외되지만 표시·멘션·그룹핑은 유지된다).
 * discord 검증(17~20자리 숫자)·별칭·키 중복·프로토타입 방어 등 나머지 규칙은 그대로 유지한다.
 * 하위호환: 값이 문자열이면 구 평면 스키마({"사내핸들": "깃헙로그인"})로 보고
 * {github: 값(빈 문자열이면 null), discord: null, discordUsername: null}로 정규화한다.
 *
 * @param {unknown} parsed JSON.parse 결과
 * @param {string} sourceLabel 오류 메시지에 표시할 출처 라벨 (예: `멘토 매핑 파일(mentors.json)`)
 * @param {{redactKeys?: boolean}} [options] redactKeys: 출처가 Secret이면 키(사내 핸들)도
 *   Secret의 일부이므로 오류 메시지에 싣지 않고 몇 번째 키인지로만 안내한다
 *   (퍼블릭 Actions 로그 유출 방지 — Actions Secret 마스킹은 값 전체 일치만 가린다).
 *   값(깃헙 로그인·디스코드 ID)은 어느 경로에서도 메시지에 싣지 않는다.
 * @returns {Record<string, MentorEntry>} 사내 핸들(소문자) → 멘토 엔트리 (null 프로토타입)
 */
export function parseMentorMapping(parsed, sourceLabel = '멘토 매핑', { redactKeys = false } = {}) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${sourceLabel}은(는) {"사내핸들": {"github": "깃헙로그인"}} 객체여야 합니다.`,
    );
  }

  // '__proto__' 같은 키가 프로토타입을 오염시키지 않도록 null 프로토타입 객체를 쓴다.
  const mapping = Object.create(null);
  // 별칭 선언은 원 핸들이 모두 등록된 뒤(2차 패스) 연결한다 — 선언 순서에 의존하지 않도록.
  const aliasDeclarations = [];

  for (const [index, [rawHandle, rawEntry]] of Object.entries(parsed).entries()) {
    const keyRef = redactKeys ? `${index + 1}번째 키` : `"${rawHandle}"`;
    const handle = normalizeKey(rawHandle);
    if (!handle) throw new Error(`${sourceLabel}의 ${keyRef}가 비어 있습니다.`);

    // 별칭 전용 항목: {"grey.great": {"aliasOf": "gray.great"}}
    if (isAliasOnlyEntry(rawEntry)) {
      const target = normalizeKey(rawEntry.aliasOf);
      if (!target) {
        throw new Error(`${sourceLabel}의 ${keyRef} aliasOf 값이 비어 있습니다(별칭 대상 핸들 필요).`);
      }
      aliasDeclarations.push({ alias: handle, target, keyRef });
      continue;
    }

    if (Object.hasOwn(mapping, handle)) {
      throw new Error(`${sourceLabel}의 ${keyRef}가 다른 항목과 중복됩니다(대소문자 차이 포함).`);
    }
    mapping[handle] = normalizeMentorEntry(rawEntry, sourceLabel, keyRef);

    for (const alias of aliasKeysOf(rawEntry, sourceLabel, keyRef)) {
      aliasDeclarations.push({ alias, target: handle, keyRef });
    }
  }

  // 2차 패스: 별칭 연결. 대상은 "실제 항목"만 인정한다(별칭 체인 금지 — 해석 순서에 따라
  // 결과가 달라지는 설정을 허용하지 않기 위함).
  const realHandles = new Set(Object.keys(mapping));
  for (const { alias, target, keyRef } of aliasDeclarations) {
    if (Object.hasOwn(mapping, alias)) {
      throw new Error(`${sourceLabel}의 ${keyRef} 별칭이 다른 항목·별칭과 중복됩니다.`);
    }
    if (!realHandles.has(target)) {
      throw new Error(
        `${sourceLabel}의 ${keyRef} 별칭 대상이 매핑에 없습니다(별칭의 별칭은 지원하지 않습니다).`,
      );
    }
    // 원 핸들과 동일한 엔트리 객체를 공유시킨다 — 디스코드 정보까지 자동으로 같아진다.
    mapping[alias] = mapping[target];
  }

  return mapping;
}

/**
 * mentors.json을 읽는다. 파일이 없으면 빈 매핑(기능 자동 비활성).
 * 파일이 있는데 형식이 잘못됐으면 설정 오류이므로 명시적으로 실패시킨다.
 * @param {string} filePath
 * @returns {Record<string, MentorEntry>}
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
 * @returns {Record<string, MentorEntry>} 사내 핸들(소문자) → 멘토 엔트리 (null 프로토타입)
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
 * 본문에서 "답변 희망(멘토)" 표기 줄과 바로 다음 내용 줄만 잘라낸다.
 * "멘토"를 선택으로 완화했으므로, "답변 희망"이 문장 속(예: "빠른 답변 희망합니다")에서
 * 걸리지 않도록 줄머리 앵커(DESIRED_HEADER_RE)로 헤더 줄만 찾는다.
 * (다음 줄이 새 섹션 헤더면 제외 — 멘토 표기가 비어 있는 템플릿 대응)
 */
function mentorSectionText(body) {
  const lines = (body ?? '').split('\n');
  const headerIndex = lines.findIndex((line) => DESIRED_HEADER_RE.test(line));
  if (headerIndex === -1) return null;

  const scanLines = [lines[headerIndex]];
  const nextLine = lines.slice(headerIndex + 1).find((line) => line.trim());
  if (nextLine && !SECTION_MARKER_RE.test(nextLine)) scanLines.push(nextLine);
  return scanLines.join('\n');
}

// ── 스키마 정규화·검증 헬퍼 ────────────────────────────────────────────────

/** 핸들·별칭 키 정규화 (문자열이 아니면 null). */
function normalizeKey(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() || null : null;
}

/** {"aliasOf": "..."} 형태의 별칭 전용 항목인지 판별. */
function isAliasOnlyEntry(rawEntry) {
  return (
    typeof rawEntry === 'object' &&
    rawEntry !== null &&
    !Array.isArray(rawEntry) &&
    Object.hasOwn(rawEntry, 'aliasOf')
  );
}

/**
 * 엔트리의 aliases 목록을 정규화한다 (없으면 빈 배열).
 * 형식이 잘못되면 설정 오류이므로 명시적으로 실패시킨다.
 */
function aliasKeysOf(rawEntry, sourceLabel, keyRef) {
  if (typeof rawEntry !== 'object' || rawEntry === null) return [];
  const raw = rawEntry.aliases;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${sourceLabel}의 ${keyRef} aliases 값이 문자열 배열이 아닙니다.`);
  }
  return raw.map((alias) => {
    const normalized = normalizeKey(alias);
    if (!normalized) {
      throw new Error(`${sourceLabel}의 ${keyRef} aliases 항목이 비어 있거나 문자열이 아닙니다.`);
    }
    return normalized;
  });
}

/**
 * 원본 값을 멘토 엔트리로 검증·정규화한다.
 * 문자열이면 구 평면 스키마로 간주(하위호환), 객체면 github(선택)·discord·discordUsername을 읽는다.
 * github는 선택 — 없거나 null/빈 문자열이면 null로 둔다("표시·멘션 전용" 멘토, 판정 제외).
 * 알 수 없는 필드(이름·부서 등 시트 원본 컬럼)는 무시한다 — 동기화 스크립트가 필드를 더 실어도
 * 알림 동작이 깨지지 않도록.
 * @returns {MentorEntry} 동결 객체
 */
function normalizeMentorEntry(rawEntry, sourceLabel, keyRef) {
  if (typeof rawEntry === 'string') {
    // 구 평면 스키마 — 빈 문자열이면 github 미기재로 보고 null로 둔다(예외 대신 정규화).
    return Object.freeze({ github: rawEntry.trim() || null, discord: null, discordUsername: null });
  }

  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
    throw new Error(
      `${sourceLabel}의 ${keyRef} 값이 올바른 깃헙 로그인이 아닙니다` +
        ' (문자열 또는 {"github": "깃헙로그인"} 객체여야 합니다).',
    );
  }

  return Object.freeze({
    github: normalizeGithubLogin(rawEntry.github, sourceLabel, keyRef),
    discord: normalizeDiscordId(rawEntry.discord, sourceLabel, keyRef),
    discordUsername: normalizeDiscordUsername(rawEntry.discordUsername, sourceLabel, keyRef),
  });
}

/**
 * 깃헙 로그인 정규화 — 선택 필드.
 * 없거나(undefined) null이거나 빈 문자열이면 null을 돌려준다("표시·멘션 전용" 멘토 — 판정 제외).
 * 값이 있으면 문자열이어야 한다 — 숫자·배열 등은 설정 오류이므로 명시적으로 실패시킨다(silent fail 금지).
 * 오류 메시지에 값 자체는 싣지 않는다 (Secret 유출 방지).
 */
function normalizeGithubLogin(raw, sourceLabel, keyRef) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error(
      `${sourceLabel}의 ${keyRef} github 값이 문자열이 아닙니다 ` +
        '(깃헙 로그인 문자열이거나, 없으면 null이어야 합니다).',
    );
  }
  return raw.trim() || null;
}

/**
 * 디스코드 숫자 ID 검증 — 없으면 null, 있으면 17~20자리 숫자 문자열이어야 한다.
 * 유저네임(anyongjun97 등)이 들어오면 멘션이 조용히 실패하므로 설정 오류로 던진다.
 * 오류 메시지에 값 자체는 싣지 않는다 (Secret 유출 방지).
 */
function normalizeDiscordId(raw, sourceLabel, keyRef) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    throw new Error(
      `${sourceLabel}의 ${keyRef} discord 값이 JSON 숫자입니다 — 17자리 이상 ID는 숫자로 적으면 ` +
        '정밀도가 깨지므로 반드시 문자열("123456789012345678")로 적어야 합니다.',
    );
  }
  if (typeof raw !== 'string') {
    throw new Error(`${sourceLabel}의 ${keyRef} discord 값이 문자열이 아닙니다.`);
  }
  const id = raw.trim();
  if (!id) return null; // 디스코드 정보가 없는 멘토(빈 칸)는 정상 — null로 둔다
  if (!DISCORD_ID_RE.test(id)) {
    throw new Error(
      `${sourceLabel}의 ${keyRef} discord 값이 디스코드 숫자 ID가 아닙니다 ` +
        '(17~20자리 숫자 문자열이어야 하며, 유저네임은 멘션에 쓸 수 없습니다). ' +
        '값을 모르면 null로 두세요.',
    );
  }
  return id;
}

/** 디스코드 유저네임(참고용) 정규화 — 없으면 null. */
function normalizeDiscordUsername(raw, sourceLabel, keyRef) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error(`${sourceLabel}의 ${keyRef} discordUsername 값이 문자열이 아닙니다.`);
  }
  return raw.trim() || null;
}

/**
 * 매핑 값에서 깃헙 로그인만 꺼낸다.
 * 정규화된 엔트리·구 스키마 문자열·정규화를 거치지 않은 raw 객체를 모두 허용한다
 * (parseMentorMapping을 거치지 않고 직접 만든 매핑을 넘기는 호출부·테스트 대응).
 * @returns {string|null}
 */
function githubOf(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (typeof entry === 'object' && entry !== null && typeof entry.github === 'string') {
    return entry.github.trim() || null;
  }
  return null;
}

/**
 * 매핑 값을 읽기용 엔트리로 정규화한다 (검증 없이 관대하게 — 조회 경로에서 예외를 던지지 않는다).
 * 검증은 parseMentorMapping이 로드 시점에 이미 수행한다.
 * @returns {MentorEntry|null}
 */
function toMentorEntry(entry) {
  const github = githubOf(entry);
  if (typeof entry === 'string') {
    return github ? Object.freeze({ github, discord: null, discordUsername: null }) : null;
  }
  if (typeof entry !== 'object' || entry === null) return null;

  const discord = typeof entry.discord === 'string' ? entry.discord.trim() : '';
  const discordUsername =
    typeof entry.discordUsername === 'string' ? entry.discordUsername.trim() : '';
  return Object.freeze({
    github,
    discord: discord && DISCORD_ID_RE.test(discord) ? discord : null,
    discordUsername: discordUsername || null,
  });
}
