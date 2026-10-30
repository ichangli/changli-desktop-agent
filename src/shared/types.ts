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
export interface SearchHit { sessionId: string; title: string; messageId: string | null; excerpt: string }
export interface RestorePreview { token: string; conversations: number; messages: number; memories: number }
export interface DesktopPreferences { closeAction: 'quit' | 'tray'; trayAvailable: boolean }
export interface PublishedRelease { tag: string; version: string; prerelease: boolean; publishedAt: string; notes: string }
export interface UpdateInfo { currentVersion: string; checkedAt: string; status: 'idle' | 'checking' | 'available' | 'current' | 'empty' | 'error'; release: PublishedRelease | null }
export interface Api {
  updateInfo(): Promise<UpdateInfo>
  checkUpdates(): Promise<UpdateInfo>
  openReleases(): Promise<void>
  desktopPreferences(): Promise<DesktopPreferences>
  saveDesktopPreferences(value: { closeAction: DesktopPreferences['closeAction'] }): Promise<DesktopPreferences>
  hideWindow(): Promise<void>
  quitApp(): Promise<void>
  renameConversation(value: { id: string; title: string }): Promise<Snapshot>
  deleteConversation(id: string): Promise<Snapshot>
  searchConversations(query: string): Promise<SearchHit[]>
  exportConversation(id: string): Promise<string>
  backupData(): Promise<string>
  prepareRestore(): Promise<RestorePreview | null>
  restoreData(token: string): Promise<string>
  cancelRestore(): Promise<void>
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
