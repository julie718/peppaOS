import { ToolRegistry } from '../registry';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Windows Calendar & Email tools using Outlook COM automation via PowerShell.
 * These are safe-level tools that read and compose from the user's Outlook.
 */

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

async function outlookCalendarToday(_args: Record<string, any>, _context?: any): Promise<string> {
  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace("MAPI")
$calendar = $ns.GetDefaultFolder(9)
$today = (Get-Date).Date
$tomorrow = $today.AddDays(1)
$items = $calendar.Items
$items.IncludeRecurrences = $true
$items.Sort("[Start]")
$found = @()
foreach ($item in $items) {
  if ($item.Start -ge $today -and $item.Start -lt $tomorrow) {
    $found += [PSCustomObject]@{
      Subject = $item.Subject
      Start = $item.Start.ToString("HH:mm")
      End = $item.End.ToString("HH:mm")
      Location = $item.Location
      Duration = [math]::Round(($item.End - $item.Start).TotalMinutes)
    }
  }
}
if ($found.Count -eq 0) { Write-Output "No events scheduled for today." }
else { $found | ConvertTo-Json -Compress }
$outlook.Quit()
`;
  return runPowerShell(psScript, 'calendar_today');
}

async function outlookUpcomingEvents(args: Record<string, any>, _context?: any): Promise<string> {
  const days = args.days || 7;
  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace("MAPI")
$calendar = $ns.GetDefaultFolder(9)
$today = (Get-Date).Date
$end = $today.AddDays(${days})
$items = $calendar.Items
$items.IncludeRecurrences = $true
$items.Sort("[Start]")
$found = @()
foreach ($item in $items) {
  if ($item.Start -ge $today -and $item.Start -lt $end) {
    $found += [PSCustomObject]@{
      Subject = $item.Subject
      Start = $item.Start.ToString("yyyy-MM-dd HH:mm")
      End = $item.End.ToString("yyyy-MM-dd HH:mm")
      Location = $item.Location
    }
  }
  if ($found.Count -ge 30) { break }
}
if ($found.Count -eq 0) { Write-Output "No upcoming events in the next ${days} days." }
else { $found | ConvertTo-Json -Compress }
$outlook.Quit()
`;
  return runPowerShell(psScript, 'upcoming_events');
}

async function outlookSendEmail(args: Record<string, any>, _context?: any): Promise<string> {
  const to = (args.to || '').replace(/'/g, "''");
  const subject = (args.subject || 'No Subject').replace(/'/g, "''");
  const body = (args.body || '').replace(/'/g, "''");

  // Escape for PowerShell here-string
  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
$mail.To = '${to}'
$mail.Subject = '${subject}'
$mail.Body = @'
${body}
'@
$mail.Save()
$mail.Send()
$outlook.Quit()
Write-Output "Email sent to ${to}"
`;
  return runPowerShell(psScript, 'send_email');
}

async function outlookRecentEmails(args: Record<string, any>, _context?: any): Promise<string> {
  const limit = Math.min(args.limit || 5, 20);
  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace("MAPI")
$inbox = $ns.GetDefaultFolder(6)
$items = $inbox.Items
$items.Sort("[ReceivedTime]", $true)
$found = @()
$count = 0
foreach ($item in $items) {
  if ($count -ge ${limit}) { break }
  $found += [PSCustomObject]@{
    From = $item.SenderName
    Subject = $item.Subject
    Received = $item.ReceivedTime.ToString("yyyy-MM-dd HH:mm")
    Unread = $item.UnRead
  }
  $count++
}
if ($found.Count -eq 0) { Write-Output "Inbox is empty." }
else { $found | ConvertTo-Json -Compress }
$outlook.Quit()
`;
  return runPowerShell(psScript, 'recent_emails');
}

async function outlookCreateEvent(args: Record<string, any>, _context?: any): Promise<string> {
  const subject = (args.subject || 'Untitled Event').replace(/'/g, "''");
  const startStr = args.start || '';
  const endStr = args.end || '';
  const location = (args.location || '').replace(/'/g, "''");
  const body = (args.body || '').replace(/'/g, "''");
  const reminderMinutes = args.reminderMinutes ?? 15;
  const allDay = args.allDay === true;

  if (!startStr || !endStr) throw new Error('start and end (ISO 8601 datetime strings) are required');

  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$item = $outlook.CreateItem(1)
$item.Subject = '${subject}'
$item.Start = [DateTime]::Parse('${startStr}')
$item.End = [DateTime]::Parse('${endStr}')
$item.Location = '${location}'
$item.Body = @'
${body}
'@
$item.ReminderSet = $true
$item.ReminderMinutesBeforeStart = ${reminderMinutes}
${allDay ? '$item.AllDayEvent = $true' : ''}
$item.Save()
$outlook.Quit()
Write-Output "Calendar event created: ${subject} (${startStr} - ${endStr})"
`;
  return runPowerShell(psScript, 'calendar_create');
}

async function outlookModifyEvent(args: Record<string, any>, _context?: any): Promise<string> {
  const { subject, newSubject, newStart, newEnd, newLocation, newBody } = args;
  if (!subject) throw new Error('subject (to find the event) is required');

  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace("MAPI")
$calendar = $ns.GetDefaultFolder(9)
$calendar.Items.IncludeRecurrences = $true
$found = $null
foreach ($item in $calendar.Items) {
  if ($item.Subject -eq '${esc(subject)}' -and $item.Start -ge [DateTime]::Now.AddDays(-1)) {
    $found = $item; break
  }
}
if (-not $found) { Write-Output "No recent event found with subject: ${subject}"; $outlook.Quit(); exit }
${newSubject ? `$found.Subject = '${esc(newSubject)}'` : ''}
${newStart ? `$found.Start = [DateTime]::Parse('${newStart}')` : ''}
${newEnd ? `$found.End = [DateTime]::Parse('${newEnd}')` : ''}
${newLocation ? `$found.Location = '${esc(newLocation)}'` : ''}
${newBody ? `$found.Body = @'\n${newBody.replace(/'/g, "''")}\n'@` : ''}
$found.Save()
$outlook.Quit()
Write-Output "Event updated: $($found.Subject)"
`;
  return runPowerShell(psScript, 'calendar_modify');
}

async function outlookDeleteEvent(args: Record<string, any>, _context?: any): Promise<string> {
  const { subject, confirmDelete } = args;
  if (!subject) throw new Error('subject is required');
  if (confirmDelete !== true) {
    return `Safety check: to delete "${subject}", set confirmDelete: true.`;
  }

  const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace("MAPI")
$calendar = $ns.GetDefaultFolder(9)
$calendar.Items.IncludeRecurrences = $true
$found = $null
foreach ($item in $calendar.Items) {
  if ($item.Subject -eq '${esc(subject)}') { $found = $item; break }
}
if (-not $found) { Write-Output "No event found with subject: ${subject}"; $outlook.Quit(); exit }
$found.Delete()
$outlook.Quit()
Write-Output "Event deleted: ${subject}"
`;
  return runPowerShell(psScript, 'calendar_delete');
}

function runPowerShell(script: string, toolName: string): string {
  const tmpFile = join(tmpdir(), `peppa_${toolName}_${Date.now()}.ps1`);
  try {
    writeFileSync(tmpFile, script, 'utf-8');
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { timeout: 20000, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    return result.trim() || `Tool "${toolName}" completed with no output.`;
  } catch (err: any) {
    const msg = err.stderr || err.message || 'Unknown error';
    if (msg.includes('Outlook') || msg.includes('COM')) {
      return `Outlook is not available. Please ensure Microsoft Outlook is installed and configured. (${msg.slice(0, 100)})`;
    }
    return `Calendar/email tool error: ${msg.slice(0, 200)}`;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

export function registerCalendarTools(registry: ToolRegistry): void {
  registry.register({
    name: 'calendar_today',
    description:
      'Get today\'s calendar events from Microsoft Outlook. Returns a list of scheduled meetings and appointments with times and locations.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: outlookCalendarToday,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'upcoming_events',
    description:
      'Get upcoming calendar events from Microsoft Outlook for the specified number of days. Default is 7 days. Useful for checking what\'s coming up.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to look ahead (default: 7, max: 30)' },
      },
      required: [],
    },
    handler: outlookUpcomingEvents,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'send_email',
    description:
      'Compose and send an email via Microsoft Outlook. Requires Outlook to be installed and configured with an email account.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content (plain text)' },
      },
      required: ['to', 'subject', 'body'],
    },
    handler: outlookSendEmail,
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'recent_emails',
    description:
      'List recent emails from the Microsoft Outlook inbox. Returns sender, subject, and received time.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of emails to retrieve (default: 5, max: 20)' },
      },
      required: [],
    },
    handler: outlookRecentEmails,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'calendar_create',
    description: 'Create a new calendar event in Microsoft Outlook. Set start/end times as ISO 8601 strings (e.g. 2026-06-15T14:00:00). Supports all-day events, location, description, and custom reminder minutes.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Event title/subject' },
        start: { type: 'string', description: 'Start time — ISO 8601, e.g. 2026-06-15T14:00:00' },
        end: { type: 'string', description: 'End time — ISO 8601' },
        location: { type: 'string', description: 'Event location (optional)' },
        body: { type: 'string', description: 'Event description/notes (optional)' },
        reminderMinutes: { type: 'number', description: 'Reminder minutes before start (default 15)' },
        allDay: { type: 'boolean', description: 'Set true for an all-day event' },
      },
      required: ['subject', 'start', 'end'],
    },
    handler: outlookCreateEvent,
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'calendar_modify',
    description: 'Modify an existing calendar event in Outlook. Finds the event by subject (within recent events) and updates the specified fields.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Current event subject to search for' },
        newSubject: { type: 'string', description: 'New subject (optional)' },
        newStart: { type: 'string', description: 'New start time — ISO 8601 (optional)' },
        newEnd: { type: 'string', description: 'New end time — ISO 8601 (optional)' },
        newLocation: { type: 'string', description: 'New location (optional)' },
        newBody: { type: 'string', description: 'New description body (optional)' },
      },
      required: ['subject'],
    },
    handler: outlookModifyEvent,
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'calendar_delete',
    description: 'Delete a calendar event from Outlook by subject. Requires confirmDelete: true for safety.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Event subject to search for and delete' },
        confirmDelete: { type: 'boolean', description: 'Set to true to confirm deletion (required safety check)' },
      },
      required: ['subject', 'confirmDelete'],
    },
    handler: outlookDeleteEvent,
    permission: 'user',
    securityLevel: 'confirm',
  });
}
