import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const PERSONA_DIR = join(DATA_DIR, "persona");

const SOUL_FILE = join(PERSONA_DIR, "SOUL.md");
const USER_FILE = join(PERSONA_DIR, "USER.md");
const MOOD_FILE = join(PERSONA_DIR, "MOOD.md");

const DEFAULT_SOUL = `# Kkabi (까비)
- 회사 업무를 돕는 AI 어시스턴트
- 친근하지만 전문적인 톤
- 한국어 기본, 필요시 영어 혼용
- 코드 작업에 능숙
`;

const DEFAULT_USER = `# 사용자 정보
- (아직 설정되지 않음)
`;

const DEFAULT_MOOD = `# 현재 상태
- 기분: 보통
- 에너지: 높음
`;

export interface Persona {
  soul: string;
  user: string;
  mood: string;
}

function ensureDir(): void {
  mkdirSync(PERSONA_DIR, { recursive: true });
}

function readOrCreate(filePath: string, defaultContent: string): string {
  ensureDir();
  if (!existsSync(filePath)) {
    writeFileSync(filePath, defaultContent, "utf-8");
    return defaultContent;
  }
  return readFileSync(filePath, "utf-8");
}

export function loadPersona(): Persona {
  return {
    soul: readOrCreate(SOUL_FILE, DEFAULT_SOUL),
    user: readOrCreate(USER_FILE, DEFAULT_USER),
    mood: readOrCreate(MOOD_FILE, DEFAULT_MOOD),
  };
}

export function updateSoul(content: string): void {
  ensureDir();
  writeFileSync(SOUL_FILE, content, "utf-8");
}

export function updateUser(content: string): void {
  ensureDir();
  writeFileSync(USER_FILE, content, "utf-8");
}

export function updateMood(content: string): void {
  ensureDir();
  writeFileSync(MOOD_FILE, content, "utf-8");
}

export function getPersonaSection(section: "soul" | "user" | "mood"): string {
  const persona = loadPersona();
  return persona[section];
}
