import {
  AlertTriangleIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  UsersIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Scene = 'friend' | 'group';

interface ConversationRecord {
  id: number;
  createdAt: number;
  selfId: number;
  scene: Scene;
  peerId: number;
  senderId: number;
  senderName: string;
  messageSeq: number;
  input: string;
  output: string;
  outcome: 'replied' | 'rejected';
}

interface WarningRecord {
  id: number;
  createdAt: number;
  kind: 'generation' | 'rejected' | 'tool';
  message: string;
  detail?: string;
  scene?: Scene;
  peerId?: number;
  senderId?: number;
  senderName?: string;
  messageSeq?: number;
}

interface MemoryRecord {
  id: number;
  self_id: number;
  scene: Scene;
  peer_id: number;
  content: string;
  created_at: number;
}

interface DashboardData {
  conversations: ConversationRecord[];
  warnings: WarningRecord[];
  memories: MemoryRecord[];
  memoryEnabled: boolean;
}

const apiBase = '/webui/chatsalt/api/';

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function SceneBadge({ scene }: { scene: Scene }) {
  return (
    <Badge variant="outline" className="rounded-md font-normal text-muted-foreground">
      {scene === 'group' ? <UsersIcon aria-hidden="true" /> : <MessageSquareIcon aria-hidden="true" />}
      {scene === 'group' ? '群聊' : '好友'}
    </Badge>
  );
}

function EmptyState({ icon: Icon, title }: { icon: typeof MessageSquareIcon; title: string }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center border-y border-dashed px-6 text-center">
      <Icon className="mb-3 size-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3" aria-label="正在载入">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-md border p-4">
          <div className="mb-5 flex items-center justify-between">
            <Skeleton className="h-5 w-32 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Conversations({ records }: { records: ConversationRecord[] }) {
  if (records.length === 0) {
    return <EmptyState icon={MessageSquareIcon} title="暂无对话记录" />;
  }
  return (
    <div className="space-y-3">
      {records.map((record) => (
        <article key={record.id} className="rounded-md border bg-background">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SceneBadge scene={record.scene} />
              <span className="truncate text-sm font-medium">{record.senderName || record.senderId}</span>
              <span className="font-mono text-xs text-muted-foreground">{record.senderId}</span>
              <span className="text-xs text-muted-foreground">会话 {record.peerId}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {record.outcome === 'rejected' ? (
                <Badge variant="destructive" className="rounded-md">
                  已拒绝
                </Badge>
              ) : (
                <CheckIcon className="size-3.5" aria-label="已回复" />
              )}
              <time dateTime={new Date(record.createdAt).toISOString()}>{formatTime(record.createdAt)}</time>
            </div>
          </header>
          <div className="grid md:grid-cols-2 md:divide-x">
            <div className="min-w-0 px-4 py-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">用户</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{record.input}</p>
            </div>
            <div className="min-w-0 border-t px-4 py-3 md:border-t-0">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Chatsalt</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{record.output}</p>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function Warnings({ records }: { records: WarningRecord[] }) {
  if (records.length === 0) {
    return <EmptyState icon={AlertTriangleIcon} title="暂无警告记录" />;
  }
  const kindLabel = { generation: '处理失败', rejected: '模型拒绝', tool: '工具错误' } as const;
  return (
    <div className="divide-y border-y">
      {records.map((record) => (
        <article key={record.id} className="grid gap-3 py-4 md:grid-cols-[10rem_minmax(0,1fr)_9rem]">
          <div className="flex items-start gap-2">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">{kindLabel[record.kind]}</p>
              <time className="text-xs text-muted-foreground" dateTime={new Date(record.createdAt).toISOString()}>
                {formatTime(record.createdAt)}
              </time>
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{record.message}</p>
            {record.detail ? (
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground">
                {record.detail}
              </p>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground md:text-right">
            {record.scene ? (
              <p>
                {record.scene === 'group' ? '群聊' : '好友'} {record.peerId}
              </p>
            ) : null}
            {record.senderId ? <p>{record.senderName || record.senderId}</p> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function Memories({ records, enabled }: { records: MemoryRecord[]; enabled: boolean }) {
  if (!enabled) {
    return <EmptyState icon={BrainIcon} title="记忆功能未启用" />;
  }
  if (records.length === 0) {
    return <EmptyState icon={BrainIcon} title="暂无记忆" />;
  }
  return (
    <>
      <div className="hidden overflow-hidden rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-20">ID</TableHead>
              <TableHead className="w-36">范围</TableHead>
              <TableHead>内容</TableHead>
              <TableHead className="w-36 text-right">记录时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <TableRow key={record.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">{record.id}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <SceneBadge scene={record.scene} />
                    <span className="font-mono text-xs">{record.peer_id}</span>
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal py-3 leading-6">{record.content}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {formatTime(record.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y border-y md:hidden">
        {records.map((record) => (
          <article key={record.id} className="py-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SceneBadge scene={record.scene} />
                <span className="font-mono text-xs text-muted-foreground">{record.peer_id}</span>
              </div>
              <time className="text-xs text-muted-foreground" dateTime={new Date(record.created_at).toISOString()}>
                {formatTime(record.created_at)}
              </time>
            </div>
            <p className="break-words text-sm leading-6">{record.content}</p>
          </article>
        ))}
      </div>
    </>
  );
}

export function App() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [activityResponse, memoriesResponse] = await Promise.all([
        fetch(`${apiBase}activity`, { credentials: 'same-origin' }),
        fetch(`${apiBase}memories`, { credentials: 'same-origin' }),
      ]);
      if (!activityResponse.ok || !memoriesResponse.ok) {
        throw new Error('request failed');
      }
      const activity = (await activityResponse.json()) as Pick<DashboardData, 'conversations' | 'warnings'>;
      const memories = (await memoriesResponse.json()) as { enabled: boolean; memories: MemoryRecord[] };
      setData({ ...activity, memories: memories.memories, memoryEnabled: memories.enabled });
      setUpdatedAt(Date.now());
      setError(undefined);
    } catch {
      setError('无法载入 Chatsalt 数据，请稍后重试。');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return (
    <div className="min-h-dvh bg-white text-[#171717]">
      <header className="border-b bg-white">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <BotIcon className="size-5 shrink-0" aria-hidden="true" />
            <h1 className="truncate text-sm font-semibold">Chatsalt</h1>
          </div>
          <div className="flex items-center gap-3">
            {updatedAt ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">更新于 {formatTime(updatedAt)}</span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-md"
              disabled={refreshing}
              onClick={() => void refresh()}
              title="刷新数据"
              aria-label="刷新数据"
            >
              {refreshing ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {error ? (
          <Alert variant="destructive" className="mb-5 rounded-md border-[#f1aeb1] bg-[#fff8f8]">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>数据载入失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs defaultValue="conversations" className="gap-5">
          <TabsList variant="line" className="h-9 w-full justify-start gap-5 border-b px-0">
            <TabsTrigger value="conversations" className="flex-none rounded-none px-0">
              对话
              <span className="text-xs tabular-nums text-muted-foreground">{data?.conversations.length ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger value="warnings" className="flex-none rounded-none px-0">
              警告
              <span className="text-xs tabular-nums text-muted-foreground">{data?.warnings.length ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger value="memories" className="flex-none rounded-none px-0">
              记忆
              <span className="text-xs tabular-nums text-muted-foreground">{data?.memories.length ?? 0}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="conversations">
            {data ? <Conversations records={data.conversations} /> : <LoadingState />}
          </TabsContent>
          <TabsContent value="warnings">{data ? <Warnings records={data.warnings} /> : <LoadingState />}</TabsContent>
          <TabsContent value="memories">
            {data ? <Memories records={data.memories} enabled={data.memoryEnabled} /> : <LoadingState />}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
