use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use crate::modules;

const DEFAULT_PROMPT: &str = "hi";
const RESET_TRIGGER_COOLDOWN_MS: i64 = 10 * 60 * 1000;
const RESET_SAFETY_MARGIN_MS: i64 = 2 * 60 * 1000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupTaskInput {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub created_at: i64,
    pub last_run_at: Option<i64>,
    pub schedule: ScheduleConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    pub repeat_mode: String,
    pub daily_times: Option<Vec<String>>,
    pub weekly_days: Option<Vec<i32>>,
    pub weekly_times: Option<Vec<String>>,
    pub interval_hours: Option<i32>,
    pub interval_start_time: Option<String>,
    pub interval_end_time: Option<String>,
    pub selected_models: Vec<String>,
    pub selected_accounts: Vec<String>,
    pub crontab: Option<String>,
    pub wake_on_reset: Option<bool>,
    pub custom_prompt: Option<String>,
    pub max_output_tokens: Option<i32>,
    pub time_window_enabled: Option<bool>,
    pub time_window_start: Option<String>,
    pub time_window_end: Option<String>,
}

#[derive(Debug, Clone)]
struct WakeupTask {
    id: String,
    name: String,
    enabled: bool,
    #[allow(dead_code)]
    created_at: i64,
    last_run_at: Option<i64>,
    schedule: ScheduleConfigNormalized,
}

#[derive(Debug, Clone)]
struct ScheduleConfigNormalized {
    repeat_mode: String,
    daily_times: Vec<String>,
    weekly_days: Vec<i32>,
    weekly_times: Vec<String>,
    interval_hours: i32,
    interval_start_time: String,
    interval_end_time: String,
    selected_models: Vec<String>,
    selected_accounts: Vec<String>,
    crontab: Option<String>,
    wake_on_reset: bool,
    custom_prompt: Option<String>,
    max_output_tokens: i32,
    time_window_enabled: bool,
    time_window_start: Option<String>,
    time_window_end: Option<String>,
}

#[derive(Default, Debug, Clone)]
struct ResetState {
    last_reset_trigger_timestamps: HashMap<String, String>,
    last_reset_trigger_at: HashMap<String, i64>,
    last_reset_remaining: HashMap<String, i32>,
}

#[derive(Default, Clone)]
struct SchedulerState {
    enabled: bool,
    tasks: Vec<WakeupTask>,
    running_tasks: HashSet<String>,
    reset_states: HashMap<String, ResetState>,
    /// 记录每个任务的实际执行时间，不会被前端 sync_state 覆盖
    last_executed_at: HashMap<String, i64>,
}

static STATE: OnceLock<Mutex<SchedulerState>> = OnceLock::new();
static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();

fn state() -> &'static Mutex<SchedulerState> {
    STATE.get_or_init(|| Mutex::new(SchedulerState::default()))
}

fn started_flag() -> &'static Mutex<bool> {
    STARTED.get_or_init(|| Mutex::new(false))
}

fn normalize_schedule(raw: ScheduleConfig) -> ScheduleConfigNormalized {
    let daily_times = raw
        .daily_times
        .filter(|times| !times.is_empty())
        .unwrap_or_else(|| vec!["08:00".to_string()]);
    let weekly_days = raw
        .weekly_days
        .filter(|days| !days.is_empty())
        .unwrap_or_else(|| vec![1, 2, 3, 4, 5]);
    let weekly_times = raw
        .weekly_times
        .filter(|times| !times.is_empty())
        .unwrap_or_else(|| vec!["08:00".to_string()]);
    let interval_hours = raw.interval_hours.unwrap_or(4).max(1);
    let interval_start_time = raw
        .interval_start_time
        .unwrap_or_else(|| "07:00".to_string());
    let interval_end_time = raw.interval_end_time.unwrap_or_else(|| "22:00".to_string());
    let max_output_tokens = raw.max_output_tokens.unwrap_or(0).max(0);
    ScheduleConfigNormalized {
        repeat_mode: raw.repeat_mode,
        daily_times,
        weekly_days,
        weekly_times,
        interval_hours,
        interval_start_time,
        interval_end_time,
        selected_models: raw.selected_models,
        selected_accounts: raw.selected_accounts,
        crontab: raw.crontab,
        wake_on_reset: raw.wake_on_reset.unwrap_or(false),
        custom_prompt: raw.custom_prompt,
        max_output_tokens,
        time_window_enabled: raw.time_window_enabled.unwrap_or(false),
        time_window_start: raw.time_window_start,
        time_window_end: raw.time_window_end,
    }
}

pub fn sync_state(enabled: bool, tasks: Vec<WakeupTaskInput>) {
    let mut guard = state().lock().expect("wakeup state lock");
    guard.enabled = enabled;
    guard.tasks = tasks
        .into_iter()
        .map(|task| WakeupTask {
            id: task.id,
            name: task.name,
            enabled: task.enabled,
            created_at: task.created_at,
            last_run_at: task.last_run_at,
            schedule: normalize_schedule(task.schedule),
        })
        .collect();
}

pub fn ensure_started(app: AppHandle) {
    let mut started = started_flag().lock().expect("wakeup started lock");
    if *started {
        return;
    }
    *started = true;

    tauri::async_runtime::spawn(async move {
        loop {
            run_scheduler_once(&app).await;
            sleep(Duration::from_secs(30)).await;
        }
    });
}

fn parse_time_to_minutes(value: &str) -> Option<i32> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: i32 = parts[0].parse().ok()?;
    let m: i32 = parts[1].parse().ok()?;
    if h < 0 || h > 23 || m < 0 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

fn is_in_time_window(start: Option<&String>, end: Option<&String>, now: DateTime<Local>) -> bool {
    let Some(start) = start else {
        return true;
    };
    let Some(end) = end else {
        return true;
    };
    let Some(start_minutes) = parse_time_to_minutes(start) else {
        return true;
    };
    let Some(end_minutes) = parse_time_to_minutes(end) else {
        return true;
    };
    let current_minutes = (now.hour() as i32) * 60 + now.minute() as i32;

    if start_minutes <= end_minutes {
        current_minutes >= start_minutes && current_minutes < end_minutes
    } else {
        current_minutes >= start_minutes || current_minutes < end_minutes
    }
}

fn next_run_time(
    schedule: &ScheduleConfigNormalized,
    after: DateTime<Local>,
) -> Option<DateTime<Local>> {
    let mut results: Vec<DateTime<Local>> = Vec::new();
    if schedule.repeat_mode == "daily" && !schedule.daily_times.is_empty() {
        let mut times = schedule.daily_times.clone();
        times.sort();
        for day_offset in 0..7 {
            for time in &times {
                if let Some(candidate) = build_datetime(after, day_offset, &time) {
                    if candidate > after {
                        results.push(candidate);
                        if !results.is_empty() {
                            return results.into_iter().min();
                        }
                    }
                }
            }
        }
    } else if schedule.repeat_mode == "weekly"
        && !schedule.weekly_days.is_empty()
        && !schedule.weekly_times.is_empty()
    {
        let mut times = schedule.weekly_times.clone();
        times.sort();
        for day_offset in 0..14 {
            let date = after + chrono::Duration::days(day_offset);
            let weekday = date.weekday().num_days_from_sunday() as i32;
            if schedule.weekly_days.contains(&weekday) {
                for time in &times {
                    if let Some(candidate) = build_datetime_from_date(date, &time) {
                        if candidate > after {
                            results.push(candidate);
                            if !results.is_empty() {
                                return results.into_iter().min();
                            }
                        }
                    }
                }
            }
        }
    } else if schedule.repeat_mode == "interval" {
        let start_time = schedule.interval_start_time.clone();
        let end_hour: i32 = schedule
            .interval_end_time
            .split(':')
            .next()
            .and_then(|h| h.parse().ok())
            .unwrap_or(22);
        let interval = schedule.interval_hours.max(1);

        for day_offset in 0..7 {
            for h in (parse_time_to_minutes(&start_time).unwrap_or(0) / 60..=end_hour)
                .step_by(interval as usize)
            {
                let time = format!(
                    "{:02}:{:02}",
                    h,
                    parse_time_to_minutes(&start_time).unwrap_or(0) % 60
                );
                if let Some(candidate) = build_datetime(after, day_offset, &time) {
                    if candidate > after {
                        results.push(candidate);
                        if !results.is_empty() {
                            return results.into_iter().min();
                        }
                    }
                }
            }
        }
    }
    None
}

fn build_datetime(base: DateTime<Local>, day_offset: i64, time: &str) -> Option<DateTime<Local>> {
    let date = base + chrono::Duration::days(day_offset);
    build_datetime_from_date(date, time)
}

fn build_datetime_from_date(date: DateTime<Local>, time: &str) -> Option<DateTime<Local>> {
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let naive_date = date.date_naive();
    let naive = naive_date.and_hms_opt(h, m, 0)?;
    Local.from_local_datetime(&naive).single()
}

fn next_crontab_time(expr: &str, after: DateTime<Local>) -> Option<DateTime<Local>> {
    let parts: Vec<&str> = expr.trim().split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let minutes = parse_cron_field(parts[0], 59)?;
    let hours = parse_cron_field(parts[1], 23)?;

    for day_offset in 0..7 {
        for h in &hours {
            for m in &minutes {
                let candidate = build_datetime(after, day_offset, &format!("{:02}:{:02}", h, m));
                if let Some(candidate) = candidate {
                    if candidate > after {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

fn parse_cron_field(field: &str, max: i32) -> Option<Vec<i32>> {
    if field == "*" {
        return Some((0..=max).collect());
    }
    if field.contains(',') {
        let mut result = Vec::new();
        for part in field.split(',') {
            result.push(part.parse().ok()?);
        }
        return Some(result);
    }
    if field.contains('-') {
        let parts: Vec<&str> = field.split('-').collect();
        if parts.len() != 2 {
            return None;
        }
        let start: i32 = parts[0].parse().ok()?;
        let end: i32 = parts[1].parse().ok()?;
        if end < start {
            return None;
        }
        return Some((start..=end).collect());
    }
    if field.contains('/') {
        let parts: Vec<&str> = field.split('/').collect();
        if parts.len() != 2 {
            return None;
        }
        let step: i32 = parts[1].parse().ok()?;
        if step <= 0 {
            return None;
        }
        let mut result = Vec::new();
        let mut value = 0;
        while value <= max {
            result.push(value);
            value += step;
        }
        return Some(result);
    }
    let value: i32 = field.parse().ok()?;
    Some(vec![value])
}

fn normalize_max_tokens(value: i32) -> u32 {
    if value > 0 {
        value as u32
    } else {
        0
    }
}

fn should_trigger_on_reset(
    state: &mut ResetState,
    model_key: &str,
    reset_at: &str,
    remaining_percent: i32,
) -> bool {
    if remaining_percent < 100 {
        state
            .last_reset_remaining
            .insert(model_key.to_string(), remaining_percent);
        return false;
    }

    let now = chrono::Utc::now().timestamp_millis();
    if let Some(last_reset_at) = state.last_reset_trigger_timestamps.get(model_key) {
        if let Ok(last_reset_time) =
            DateTime::parse_from_rfc3339(last_reset_at).map(|dt| dt.timestamp_millis())
        {
            let safe_time = last_reset_time + RESET_SAFETY_MARGIN_MS;
            if now < safe_time {
                state
                    .last_reset_remaining
                    .insert(model_key.to_string(), remaining_percent);
                return false;
            }
        }
    }

    if let Some(last_trigger_at) = state.last_reset_trigger_at.get(model_key) {
        if now - *last_trigger_at < RESET_TRIGGER_COOLDOWN_MS {
            state
                .last_reset_remaining
                .insert(model_key.to_string(), remaining_percent);
            return false;
        }
    }

    if state.last_reset_trigger_timestamps.get(model_key) == Some(&reset_at.to_string()) {
        state
            .last_reset_remaining
            .insert(model_key.to_string(), remaining_percent);
        return false;
    }

    state
        .last_reset_remaining
        .insert(model_key.to_string(), remaining_percent);
    true
}

fn mark_reset_triggered(state: &mut ResetState, model_key: &str, reset_at: &str) {
    state
        .last_reset_trigger_timestamps
        .insert(model_key.to_string(), reset_at.to_string());
    state
        .last_reset_trigger_at
        .insert(model_key.to_string(), chrono::Utc::now().timestamp_millis());
}

async fn run_scheduler_once(app: &AppHandle) {
    let snapshot = {
        let guard = state().lock().expect("wakeup state lock");
        guard.clone()
    };

    if !snapshot.enabled {
        return;
    }

    let now = Local::now();

    for task in snapshot.tasks.iter() {
        if !task.enabled {
            continue;
        }
        if snapshot.running_tasks.contains(&task.id) {
            continue;
        }

        if task.schedule.wake_on_reset {
            handle_quota_reset_task(app, task, now).await;
            continue;
        }

        // 优先使用本地记录的执行时间，避免被前端同步覆盖导致重复执行
        let local_last_run = snapshot.last_executed_at.get(&task.id).copied();
        let after = local_last_run
            .or(task.last_run_at)
            .and_then(|ts| Local.timestamp_millis_opt(ts).single())
            .unwrap_or_else(|| now - chrono::Duration::minutes(1));

        let next_run = if let Some(expr) = &task.schedule.crontab {
            next_crontab_time(expr, after)
        } else {
            next_run_time(&task.schedule, after)
        };

        // 只有到达预定时间才触发（不再提前30秒）
        if let Some(next_run) = next_run {
            if next_run <= now {
                run_task(app, task, "scheduled").await;
            }
        }
    }
}

async fn handle_quota_reset_task(app: &AppHandle, task: &WakeupTask, now: DateTime<Local>) {
    if task.schedule.time_window_enabled
        && !is_in_time_window(
            task.schedule.time_window_start.as_ref(),
            task.schedule.time_window_end.as_ref(),
            now,
        )
    {
        return;
    }

    let accounts = match modules::list_accounts() {
        Ok(list) => list,
        Err(_) => return,
    };

    let selected_accounts: Vec<_> = task
        .schedule
        .selected_accounts
        .iter()
        .filter_map(|email| {
            accounts
                .iter()
                .find(|acc| acc.email.eq_ignore_ascii_case(email))
        })
        .collect();

    if selected_accounts.is_empty() {
        return;
    }

    let models_to_trigger = {
        let mut state_guard = state().lock().expect("wakeup state lock");
        let reset_state = state_guard
            .reset_states
            .entry(task.id.clone())
            .or_insert_with(ResetState::default);

        let mut models_to_trigger: HashSet<String> = HashSet::new();
        for model_id in &task.schedule.selected_models {
            for account in &selected_accounts {
                let quota_models = account
                    .quota
                    .as_ref()
                    .map(|q| q.models.as_slice())
                    .unwrap_or(&[]);
                if let Some(quota) = quota_models.iter().find(|item| item.name == *model_id) {
                    if should_trigger_on_reset(
                        reset_state,
                        model_id,
                        &quota.reset_time,
                        quota.percentage,
                    ) {
                        models_to_trigger.insert(model_id.clone());
                        mark_reset_triggered(reset_state, model_id, &quota.reset_time);
                    }
                }
            }
        }
        models_to_trigger
    };

    if !models_to_trigger.is_empty() {
        run_task_with_models(
            app,
            task,
            "quota_reset",
            models_to_trigger.into_iter().collect(),
        )
        .await;
    }
}

async fn run_task(app: &AppHandle, task: &WakeupTask, trigger_source: &str) {
    run_task_with_models(
        app,
        task,
        trigger_source,
        task.schedule.selected_models.clone(),
    )
    .await;
}

async fn run_task_with_models(
    app: &AppHandle,
    task: &WakeupTask,
    trigger_source: &str,
    models: Vec<String>,
) {
    if models.is_empty() {
        return;
    }

    let accounts = match modules::list_accounts() {
        Ok(list) => list,
        Err(_) => return,
    };

    let selected_accounts: Vec<_> = task
        .schedule
        .selected_accounts
        .iter()
        .filter_map(|email| {
            accounts
                .iter()
                .find(|acc| acc.email.eq_ignore_ascii_case(email))
        })
        .collect();

    if selected_accounts.is_empty() {
        return;
    }

    {
        let mut guard = state().lock().expect("wakeup state lock");
        guard.running_tasks.insert(task.id.clone());
    }

    let prompt = task
        .schedule
        .custom_prompt
        .as_ref()
        .and_then(|p| {
            if p.trim().is_empty() {
                None
            } else {
                Some(p.trim().to_string())
            }
        })
        .unwrap_or_else(|| DEFAULT_PROMPT.to_string());
    let max_tokens = normalize_max_tokens(task.schedule.max_output_tokens);

    let mut history: Vec<modules::wakeup_history::WakeupHistoryItem> = Vec::new();
    for account in &selected_accounts {
        for model in &models {
            let started = chrono::Utc::now();
            let result =
                modules::wakeup::trigger_wakeup(&account.id, model, &prompt, max_tokens).await;
            let duration = chrono::Utc::now()
                .signed_duration_since(started)
                .num_milliseconds()
                .max(0) as u64;
            let (success, message) = match result {
                Ok(resp) => {
                    // 唤醒成功说明 Token 有效，清除 disabled 和 quota_error
                    if let Ok(mut acc) = modules::load_account(&account.id) {
                        let mut changed = false;
                        if acc.disabled {
                            modules::logger::log_info(&format!(
                                "[WakeupScheduler] 唤醒成功，自动解除禁用状态: {}",
                                acc.email
                            ));
                            acc.disabled = false;
                            acc.disabled_reason = None;
                            acc.disabled_at = None;
                            changed = true;
                        }
                        if changed {
                            acc.quota_error = None;
                            let _ = modules::save_account(&acc);
                        }
                    }
                    (true, Some(resp.reply))
                }
                Err(err) => (false, Some(err.to_string())),
            };
            history.push(modules::wakeup_history::WakeupHistoryItem {
                id: format!(
                    "{}-{}",
                    chrono::Utc::now().timestamp_millis(),
                    history.len()
                ),
                timestamp: chrono::Utc::now().timestamp_millis(),
                trigger_type: "auto".to_string(),
                trigger_source: trigger_source.to_string(),
                task_name: Some(task.name.clone()),
                account_email: account.email.clone(),
                model_id: model.clone(),
                prompt: Some(prompt.clone()),
                success,
                message,
                duration: Some(duration),
            });
        }
    }

    {
        let mut guard = state().lock().expect("wakeup state lock");
        guard.running_tasks.remove(&task.id);
        let executed_at = chrono::Utc::now().timestamp_millis();
        guard.tasks.iter_mut().for_each(|item| {
            if item.id == task.id {
                item.last_run_at = Some(executed_at);
            }
        });
        // 记录本地执行时间，防止被前端同步覆盖导致重复执行
        guard.last_executed_at.insert(task.id.clone(), executed_at);
    }

    // 写入历史文件
    if let Err(e) = modules::wakeup_history::add_history_items(history.clone()) {
        modules::logger::log_error(&format!("写入唤醒历史失败: {}", e));
    }

    let payload = WakeupTaskResultPayload {
        task_id: task.id.clone(),
        last_run_at: chrono::Utc::now().timestamp_millis(),
        records: history,
    };
    let _ = app.emit("wakeup://task-result", payload);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeupTaskResultPayload {
    task_id: String,
    last_run_at: i64,
    records: Vec<modules::wakeup_history::WakeupHistoryItem>,
}

// (no local helpers)
