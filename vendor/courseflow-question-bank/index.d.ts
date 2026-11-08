export const INTERFACE_VERSION: 1;
export interface Option { id: string; text: string }
export interface Question { id?: string; kind: 'single' | 'multiple' | 'judge' | 'blank' | 'essay'; text: string; options: Option[]; blanks: number; images?: string[]; context?: string }
export interface Scope { owner: string; platform: string; course: string }
export interface Entry { version: 1; correct: string[] | null; wrong: string[][]; updated_at: number }
export interface Store { get(key: string): Entry | undefined; put(key: string, value: Entry): void }
export interface Match { correct: string[] | null; wrong: string[][]; updated_at: number | null }
export interface Evidence { result: 'correct' | 'incorrect'; source: 'platform' | 'reviewed'; at?: number }
export interface Candidate { answer: string[]; explanation?: string; confidence?: number }
export interface QueryContext { signal?: AbortSignal; onError?: (provider: string, error: unknown) => void }
export interface QuestionBankProvider { id: string; query(question: Question, context: QueryContext): Promise<Candidate | null> }
export interface Request { method: string; url: string; headers?: Record<string, string>; body?: string }
export type Transport = (request: Request, context: QueryContext) => Promise<unknown>;
export function validateQuestion(question: Question): void;
export function validateAnswer(question: Question, answer: unknown): answer is string[];
export function fingerprint(scope: Scope, question: Question): string;
export class QuestionBank { constructor(store: Store); lookup(scope: Scope, question: Question): Match; record(scope: Scope, question: Question, answer: string[], evidence: Evidence): void }
export function queryProviders(providers: QuestionBankProvider[], question: Question, context?: QueryContext): Promise<(Candidate & { provider: string }) | null>;
export function createJsonProvider(options: { id: string; request: (question: Question) => Request; parse: (response: unknown, question: Question) => Candidate | null }, transport: Transport): QuestionBankProvider;
export function candidate(question: Question, raw: unknown): Candidate | null;
export function createYanxiProvider(options: { url: string; token: string; id?: string }, transport: Transport): QuestionBankProvider;
export function createTikuAdapterProvider(options: { url: string; id?: string }, transport: Transport): QuestionBankProvider;
export function createTikuLikeProvider(options: { url: string; token: string; model?: string; search?: boolean; vision?: boolean; id?: string }, transport: Transport): QuestionBankProvider;
