import { create } from 'zustand';
import { useAccountStore } from './useAccountStore';
import { Account } from '../types/account';

export type TaskStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface Task {
  id: string;
  prompt: string;
  requiredModel: string;
  status: TaskStatus;
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
  addTask: (prompt: string, requiredModel: string) => void;
  startWorkers: () => void;
  pauseWorkers: () => void;
  clearTasks: () => void;
  // Internal method used by the worker loop
  _processNextBatch: () => void;
}

const MOCK_API_DELAY = 3000;

// Simulate hitting an AI provider
const mockAIApiCall = async (prompt: string, model: string, account: Account) => {
  return new Promise<string>((resolve, reject) => {
    setTimeout(() => {
      // randomly fail 10% of the time to simulate rate limits
      if (Math.random() < 0.1) {
        reject(new Error(`Rate limit exceeded for account ${account.email}`));
      } else {
        resolve(`[${model}] Mock response from ${account.email} for prompt: "${prompt.substring(0, 20)}..."`);
      }
    }, MOCK_API_DELAY);
  });
};

export const useTaskWorkerStore = create<TaskWorkerState>((set, get) => {
  let workerInterval: NodeJS.Timeout | null = null;
  const activeTaskIds = new Set<string>();

  return {
    tasks: [],
    isProcessing: false,
    concurrencyLimit: 2, // How many tasks to process simultaneously

    addTask: (prompt, requiredModel) => {
      const newTask: Task = {
        id: crypto.randomUUID(),
        prompt,
        requiredModel,
        status: 'pending',
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
        
        // Find an account that has a model mimicking `requiredModel` with > 5% quota
        const targetAccount = availableAccounts.find(acc => {
          if (!acc.quota || !acc.quota.models) return false;
          return acc.quota.models.some(
            m => m.name.toLowerCase().includes(task.requiredModel.toLowerCase()) && m.percentage > 5
          );
        });

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
              const result = await mockAIApiCall(task.prompt, task.requiredModel, targetAccount);
              
              // Success
              set((s) => ({
                tasks: s.tasks.map((t) => 
                  t.id === task.id ? { ...t, status: 'done', result, completedAt: Date.now() } : t
                )
              }));
            } catch (error: any) {
              // Failed -> mark as failed (could implement retry logic here and set back to 'pending')
              set((s) => ({
                tasks: s.tasks.map((t) => 
                  t.id === task.id ? { ...t, status: 'failed', error: error.message, completedAt: Date.now() } : t
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
