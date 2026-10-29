export type Status = 'generating' | 'complete' | 'stopped' | 'interrupted' | 'failed'
export interface Message { id: string; sessionId: string; role: 'user' | 'assistant'; content: string; status: Status; createdAt: string; error: string }
export interface Conversation { id: string; title: string; createdAt: string }
export interface Settings { mode: 'demo' | 'chat-completions'; endpoint: string; model: string; hasKey: boolean }
export interface Snapshot { conversations: Conversation[]; selectedId: string; messages: Message[]; activeId: string | null; settings: Settings; fault: string }
export interface SettingsInput { mode: Settings['mode']; endpoint: string; model: string; key?: string; clearKey?: boolean }
export interface Memory { id: string; content: string; category: 'fact' | 'roleplay'; source: string; createdAt: string; updatedAt: string }
export interface MemoryInput { id?: string; content: string; category: Memory['category']; source?: string }
export interface AllowedApp { id: string; name: string; target: string; approved: boolean; fingerprint: string }
export type ToolStatus = 'waiting' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout' | 'uncertain'
export interface ToolRecord { id: string; sessionId: string; name: string; target: string; status: ToolStatus; result: string; createdAt: string }
export interface Workspace { memories: Memory[]; apps: AllowedApp[]; tools: ToolRecord[] }
export interface Api {
  workspace(): Promise<Workspace>
  saveMemory(value: MemoryInput): Promise<Workspace>
  deleteMemory(id: string): Promise<Workspace>
  configureApp(): Promise<Workspace>
  renameApp(value: { id: string; name: string }): Promise<Workspace>
  grantApp(value: { id: string; approved: boolean }): Promise<Workspace>
  runTool(value: { name: string; args: unknown; id: string }): Promise<Workspace>
  snapshot(): Promise<Snapshot>
  create(): Promise<Snapshot>
  select(id: string): Promise<Snapshot>
  send(text: string): Promise<void>
  retry(id: string): Promise<void>
  stop(): Promise<void>
  saveSettings(value: SettingsInput): Promise<Snapshot>
  testConnection(): Promise<string>
  onChange(callback: (value: Snapshot) => void): () => void
}
