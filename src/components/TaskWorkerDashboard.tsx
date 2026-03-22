import React, { useState } from 'react';
import { useTaskWorkerStore } from '../stores/useTaskWorkerStore';
import { Play, Pause, Plus, Trash2, CheckCircle2, XCircle, Loader2, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const TaskWorkerDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { tasks, isProcessing, apiUrl, setApiUrl, startWorkers, pauseWorkers, addTask, clearTasks } = useTaskWorkerStore();
  const [promptInput, setPromptInput] = useState('');
  const [modelSelect, setModelSelect] = useState('Claude 4.5'); // Or 'Gemini Pro'

  const handleAddTask = () => {
    if (!promptInput.trim()) return;
    addTask(promptInput, modelSelect);
    setPromptInput('');
  };

  const handleAddDummyBatch = () => {
    for (let i = 1; i <= 5; i++) {
        addTask(`Dummy task ${i}: Summarize the benefits of AI.`, 'Claude 4.5');
    }
    for (let i = 1; i <= 5; i++) {
        addTask(`Dummy task ${i + 5}: Generate a python script for sorting.`, 'Gemini Pro');
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700 mb-6 overflow-hidden">
      <div className="p-5">
        <div className="flex justify-between items-center mb-5 flex-wrap gap-3 border-b border-gray-100 dark:border-gray-700 pb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 m-0 text-gray-800 dark:text-white">
            <Bot className="text-primary" size={24} />
            Multi-Agent Worker Pool
          </h2>
          <div className="flex items-center gap-3">
            <input 
              type="text" 
              className="input input-sm input-bordered w-64 text-xs font-mono" 
              placeholder="API Base URL (e.g. http://127.0.0.1:3000/v1)"
              title="Antigravity local proxy or external API base URL"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
            />
            <div className="flex gap-2">
            {isProcessing ? (
              <button className="btn btn-warning btn-sm" onClick={pauseWorkers}>
                <Pause size={16} /> Pause Workers
              </button>
            ) : (
              <button className="btn btn-success btn-sm text-white" onClick={startWorkers}>
                <Play size={16} /> Start Workers
              </button>
            )}
            <button className="btn btn-error btn-outline btn-sm" onClick={clearTasks}>
              <Trash2 size={16} /> Clear
            </button>
          </div>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <input 
            type="text" 
            placeholder="Enter prompt..." 
            className="input input-sm input-bordered flex-1"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddTask()}
          />
          <select 
            className="select select-sm select-bordered" 
            value={modelSelect} 
            onChange={(e) => setModelSelect(e.target.value)}
          >
            <option value="Claude 4.5">Claude 4.5</option>
            <option value="Gemini Pro">Gemini Pro</option>
            <option value="Gemini Flash">Gemini Flash</option>
            <option value="GPT-4O">GPT-4O</option>
          </select>
          <button className="btn btn-primary btn-sm" onClick={handleAddTask}>
            <Plus size={16} /> Add 
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleAddDummyBatch}>
            Add Batch (10)
          </button>
        </div>

        <div className="overflow-x-auto border border-base-200 rounded-lg max-h-[300px] overflow-y-auto w-full">
          <table className="table table-xs table-pin-rows w-full">
            <thead>
              <tr className="bg-base-200/50">
                <th>Status</th>
                <th>Model</th>
                <th>Account Assigned</th>
                <th>Prompt / Result</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center py-6 text-base-content/50">
                    No tasks in queue. Add some tasks to start the worker pool.
                  </td>
                </tr>
              )}
              {tasks.map((task) => (
                <tr key={task.id} className={task.status === 'processing' ? 'bg-base-200/40' : ''}>
                  <td className="w-[100px]">
                    {task.status === 'pending' && <span className="badge badge-ghost badge-sm border-base-300 shadow-sm text-xs">Pending</span>}
                    {task.status === 'processing' && <span className="badge badge-primary badge-sm text-xs shadow-sm"><Loader2 size={12} className="animate-spin mr-1" /> Executing</span>}
                    {task.status === 'done' && <span className="badge badge-success badge-sm text-white text-xs shadow-sm"><CheckCircle2 size={12} className="mr-1" /> Done</span>}
                    {task.status === 'failed' && <span className="badge badge-error badge-sm text-white text-xs shadow-sm"><XCircle size={12} className="mr-1" /> Failed</span>}
                  </td>
                  <td className="w-[120px]"><span className="font-semibold text-xs opacity-90">{task.requiredModel}</span></td>
                  <td className="font-mono text-[11px] w-[180px] max-w-[180px] truncate opacity-75" title={task.assignedAccountEmail || '-'}>
                    {task.assignedAccountEmail || '-'}
                  </td>
                  <td className="max-w-[400px] truncate text-sm" title={task.result || task.error || task.prompt}>
                    {task.status === 'done' && <span className="text-success font-medium">{task.result}</span>}
                    {task.status === 'failed' && <span className="text-error font-medium">{task.error}</span>}
                    {(task.status === 'pending' || task.status === 'processing') && <span className="text-base-content/80 text-sm">{task.prompt}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        <div className="mt-4 pt-3 border-t border-base-200 text-xs text-base-content/60 flex justify-between font-medium">
          <span className="bg-base-200 px-2 py-1 rounded">Total Tasks: {tasks.length}</span>
          <span className="flex gap-2">
            <span className="bg-base-200 px-2 py-1 rounded">Pending: {tasks.filter(t => t.status === 'pending').length}</span>
            <span className="bg-primary/10 text-primary px-2 py-1 rounded">Processing: {tasks.filter(t => t.status === 'processing').length}</span>
            <span className="bg-success/10 text-success px-2 py-1 rounded">Done: {tasks.filter(t => t.status === 'done').length}</span>
          </span>
        </div>
      </div>
    </div>
  );
};
