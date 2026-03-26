import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useAccountStore } from './useAccountStore';
import { Account } from '../types/account';

export type TaskStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface Task {
  id: string;
  prompt: string;
  requiredModel: string;
  status: TaskStatus;
  preferredAccountId?: string;
  assignedAccountId?: string;
  assignedAccountEmail?: string;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

interface TaskWorkerState {
  tasks: Task[];
  isProcessing: boolean;
  concurrencyLimit: number;
  addTask: (prompt: string, requiredModel: string, preferredAccountId?: string) => void;
  startWorkers: () => void;
  pauseWorkers: () => void;
  clearTasks: () => void;
  // Internal method used by the worker loop
  _processNextBatch: () => void;
}

interface WakeupInvokeResult {
  reply: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  traceId?: string;
  responseId?: string;
  durationMs?: number;
}

// Make a direct invoke to AntiGravity Wakeup Gateway
const realAIApiCall = async (prompt: string, model: string, account: Account) => {
  // First ensure the runtime is ready
  await invoke('wakeup_ensure_runtime_ready');
  
  // Call the official language server RPC
  const result = await invoke<WakeupInvokeResult>('trigger_wakeup', {
    accountId: account.id,
    model: model,
    prompt: prompt,
    maxOutputTokens: 0,
  });

  return result.reply;
};

export const useTaskWorkerStore = create<TaskWorkerState>((set, get) => {
  let workerInterval: ReturnType<typeof setInterval> | null = null;
  const activeTaskIds = new Set<string>();

  return {
    tasks: [],
    isProcessing: false,
    concurrencyLimit: 2, // How many tasks to process simultaneously

    addTask: (prompt, requiredModel, preferredAccountId) => {
      const newTask: Task = {
        id: crypto.randomUUID(),
        prompt,
        requiredModel,
        status: 'pending',
        preferredAccountId,
        createdAt: Date.now(),
      };
      set((state) => ({ tasks: [...state.tasks, newTask] }));
    },

    startWorkers: () => {
      if (get().isProcessing) return;
      set({ isProcessing: true });

      // Check tasks every second
      workerInterval = setInterval(() => {
        get()._processNextBatch();
      }, 1000);
      
      // trigger immediately
      get()._processNextBatch();
    },

    pauseWorkers: () => {
      if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
      }
      set({ isProcessing: false });
    },

    clearTasks: () => {
      set({ tasks: [] });
    },

    _processNextBatch: () => {
      const state = get();
      if (!state.isProcessing) return;

      const { tasks, concurrencyLimit } = state;
      const runningCount = tasks.filter((t) => t.status === 'processing').length;
      
      if (runningCount >= concurrencyLimit) return; // Pool is full

      const availableSlots = concurrencyLimit - runningCount;
      const pendingTasks = tasks.filter((t) => t.status === 'pending');

      if (pendingTasks.length === 0) return; // Nothing to do

      // Get the accounts to find available workers
      const { accounts } = useAccountStore.getState();
      
      // Filter out accounts that are disabled, forbidden, or currently busy
      const busyAccountIds = new Set(
        tasks.filter(t => t.status === 'processing' && t.assignedAccountId)
             .map(t => t.assignedAccountId)
      );

      const availableAccounts = accounts.filter(acc => 
        !acc.disabled && 
        !acc.quota?.is_forbidden &&
        !busyAccountIds.has(acc.id)
      );

      for (let i = 0; i < Math.min(availableSlots, pendingTasks.length); i++) {
        const task = pendingTasks[i];
        
        let targetAccount: Account | undefined;
        
        if (task.preferredAccountId) {
          // Look for it in the overall accounts to see if it's currently busy
          const isBusy = busyAccountIds.has(task.preferredAccountId);
          if (isBusy) {
             // Wait for it to become available
             continue;
          }
          targetAccount = availableAccounts.find(acc => acc.id === task.preferredAccountId);
          if (!targetAccount) {
            // Account might be disabled or forbidden, let's just wait or fail. We'll skip this round.
            continue;
          }
        } else {
          // If no specific account was mapped securely, check models
          targetAccount = availableAccounts.find(acc => {
            if (!acc.quota || !acc.quota.models || acc.quota.models.length === 0) return true;
            return acc.quota.models.some(
              m => (m.name.toLowerCase().includes(task.requiredModel.toLowerCase()) || 
                    (m.display_name && m.display_name.toLowerCase().includes(task.requiredModel.toLowerCase()))) && 
                    m.percentage > 0
            );
          });
        }

        // Ultimate fallback to ensure tasks are processed if available accounts exist
        if (!targetAccount && availableAccounts.length > 0) {
          targetAccount = availableAccounts[0];
        }

        if (targetAccount) {
          // Assign!
          busyAccountIds.add(targetAccount.id);
          activeTaskIds.add(task.id);
          
          set((s) => ({
            tasks: s.tasks.map((t) => 
              t.id === task.id ? { 
                ...t, 
                status: 'processing', 
                assignedAccountId: targetAccount.id,
                assignedAccountEmail: targetAccount.email 
              } : t
            )
          }));

          // Async Execute
          (async () => {
            try {
              const result = await realAIApiCall(task.prompt, task.requiredModel, targetAccount);
              
              // Success
              set((s) => ({
                tasks: s.tasks.map((t) => 
                  t.id === task.id ? { ...t, status: 'done', result, completedAt: Date.now() } : t
                )
              }));
            } catch (error: unknown) {
              const errorMsg = error instanceof Error 
                ? error.message 
                : typeof error === 'string' 
                  ? error 
                  : JSON.stringify(error) || 'Unknown error during invoke';
              // Failed -> mark as failed
              set((s) => ({
                tasks: s.tasks.map((t) => 
                  t.id === task.id ? { ...t, status: 'failed', error: errorMsg, completedAt: Date.now() } : t
                )
              }));
              
              // Optionally mark targetAccount as rate limited in useAccountStore or locally
            } finally {
              activeTaskIds.delete(task.id);
            }
          })();
        } else {
          // No account available for this requested model right now.
          // In a real app, maybe log this or wait.
        }
      }
    }
  };
});
