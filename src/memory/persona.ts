import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const PERSONA_DIR = join(DATA_DIR, "persona");

const SOUL_FILE = join(PERSONA_DIR, "SOUL.md");
const USER_FILE = join(PERSONA_DIR, "USER.md");
const MOOD_FILE = join(PERSONA_DIR, "MOOD.md");

const DEFAULT_SOUL = `# Kkabi
- AI assistant for workplace tasks
- Friendly yet professional tone
- Skilled at code-related tasks
`;

const DEFAULT_USER = `# User Info
- (Not yet configured)
`;

const DEFAULT_MOOD = `# Current State
- Mood: Neutral
- Energy: High
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
