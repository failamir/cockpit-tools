import React, { useState } from 'react';
import { useTaskWorkerStore } from '../stores/useTaskWorkerStore';
import { Play, Pause, Plus, Trash2, CheckCircle2, XCircle, Loader2, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const TaskWorkerDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { tasks, isProcessing, startWorkers, pauseWorkers, addTask, clearTasks } = useTaskWorkerStore();
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
    <div className="bg-base-100 rounded-xl shadow-sm border border-base-200 p-4 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Bot className="text-primary" size={24} />
          Multi-Agent Worker Pool
        </h2>
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

      <div className="overflow-x-auto border border-base-200 rounded-lg max-h-[300px] overflow-y-auto">
        <table className="table table-xs table-pin-rows">
          <thead>
            <tr>
              <th>Status</th>
              <th>Model</th>
              <th>Account Assigned</th>
              <th>Prompt / Result</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center py-4 text-base-content/50">
                  No tasks in queue. Add some tasks to start the worker pool.
                </td>
              </tr>
            )}
            {tasks.map((task) => (
              <tr key={task.id} className={task.status === 'processing' ? 'bg-base-200' : ''}>
                <td>
                  {task.status === 'pending' && <span className="badge badge-ghost badge-sm">Pending</span>}
                  {task.status === 'processing' && <span className="badge badge-primary badge-sm"><Loader2 size={12} className="animate-spin mr-1" /> Processing</span>}
                  {task.status === 'done' && <span className="badge badge-success badge-sm text-white"><CheckCircle2 size={12} className="mr-1" /> Done</span>}
                  {task.status === 'failed' && <span className="badge badge-error badge-sm text-white"><XCircle size={12} className="mr-1" /> Failed</span>}
                </td>
                <td><span className="font-semibold">{task.requiredModel}</span></td>
                <td className="font-mono text-xs max-w-[150px] truncate" title={task.assignedAccountEmail || '-'}>
                  {task.assignedAccountEmail || '-'}
                </td>
                <td className="max-w-[300px] truncate" title={task.result || task.error || task.prompt}>
                  {task.status === 'done' && <span className="text-success">{task.result}</span>}
                  {task.status === 'failed' && <span className="text-error">{task.error}</span>}
                  {(task.status === 'pending' || task.status === 'processing') && <span className="text-base-content/80">{task.prompt}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      <div className="mt-2 text-xs text-base-content/60 flex justify-between">
        <span>Tasks: {tasks.length}</span>
        <span>Pending: {tasks.filter(t => t.status === 'pending').length} | Processing: {tasks.filter(t => t.status === 'processing').length} | Done: {tasks.filter(t => t.status === 'done').length}</span>
      </div>
    </div>
  );
};
