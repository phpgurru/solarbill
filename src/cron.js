// Daily cron: email a reminder once a month, a couple of days after a user's bill is usually issued.
import { now } from './util.js';
import { sendBatch, reminderEmail } from './email.js';
import { unsubscribeUrl } from './auth.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function runReminders(env, when = new Date()) {
  // Work in Pakistan time (UTC+5)
  const pk = new Date(when.getTime() + 5 * 3600 * 1000);
  const month = `${pk.getUTCFullYear()}-${String(pk.getUTCMonth() + 1).padStart(2, '0')}`;
  const day = pk.getUTCDate();

  // Users with reminders on, at least one meter, not yet reminded this month
  const users = (await env.DB.prepare(`
    SELECT u.id, u.email,
      (SELECT COUNT(*) FROM meters m WHERE m.user_id = u.id) AS meters,
      (SELECT COUNT(DISTINCT b.meter_id) FROM bills b WHERE b.user_id = u.id AND b.month = ?) AS done,
      (SELECT MAX(b.issue_day) FROM bills b WHERE b.user_id = u.id) AS issue_day
    FROM users u
    WHERE u.reminders = 1
      AND NOT EXISTS (SELECT 1 FROM reminder_log r WHERE r.user_id = u.id AND r.month = ?)
    LIMIT 500`).bind(month, month).all()).results;

  const due = users.filter(u => u.meters > 0 && u.done < u.meters && day >= Math.min((u.issue_day || 20) + 2, 27));
  const label = `${MONTHS[pk.getUTCMonth()]} ${pk.getUTCFullYear()}`;
  let sent = 0;
  for (let i = 0; i < due.length; i += 50) {
    const chunk = due.slice(i, i + 50);
    const emails = await Promise.all(chunk.map(async u => ({ to: u.email, ...reminderEmail(env, { monthLabel: label, unsubscribeUrl: await unsubscribeUrl(env, u.id), meterCount: u.meters }) })));
    await sendBatch(env, emails);
    await env.DB.batch(chunk.map(u => env.DB.prepare('INSERT OR IGNORE INTO reminder_log (user_id, month, sent_at) VALUES (?, ?, ?)').bind(u.id, month, now())));
    sent += chunk.length;
  }
  console.log(`reminders: month=${month} day=${day} candidates=${users.length} sent=${sent}`);
  return { month, day, candidates: users.length, sent };
}
