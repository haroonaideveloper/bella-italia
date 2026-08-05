// /api/availability.js
// Runs on Vercel's server — never sent to the browser.
// Uses ONE shared Google Calendar ("Grand Horizon Medical Center").
// Each appointment event's TITLE contains the doctor's name — that's how we tell
// whose slot is busy, so Dr. A's 12:00 appointment never blocks Dr. B's 12:00 slot.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { doctor_name, date, slot_duration_minutes } = req.body || {};
  if (!doctor_name || !date) {
    return res.status(400).json({ error: 'doctor_name and date are required' });
  }

  const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID; // the ONE "Grand Horizon Medical Center" calendar
  if (!CALENDAR_ID) {
    return res.status(500).json({ error: 'GOOGLE_CALENDAR_ID is not set' });
  }

  // Turns "Dr. Marcus Webb" into "marcus webb" — punctuation-insensitive, so it matches
  // titles written as "Dr. Marcus Webb", "DR, Marcus Webb", "Marcus Webb - Follow-up", etc.
  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const doctorNorm = normalize(doctor_name.replace(/^dr\.?\s*/i, ''));
  const doctorLastName = doctorNorm.split(' ').pop(); // most reliable single token to match on

  try {
    // 1) Exchange the long-lived refresh token for a short-lived access token.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Google token refresh failed:', tokenData);
      return res.status(502).json({ error: 'Could not refresh Google token' });
    }

    // 2) Pull every event on the shared calendar for that day (clinic hours 10:00–22:00).
    // The clinic runs on Kyrgyzstan time (UTC+6). Vercel's server clock is UTC, so this
    // MUST be anchored explicitly — otherwise "10:00" gets read as 10:00 UTC (= 4:00 PM
    // clinic time) and never lines up with the calendar's real busy times.
    const CLINIC_UTC_OFFSET = '+06:00';
    const timeMin = new Date(`${date}T10:00:00${CLINIC_UTC_OFFSET}`).toISOString();
    const timeMax = new Date(`${date}T22:00:00${CLINIC_UTC_OFFSET}`).toISOString();
    const params = new URLSearchParams({
      timeMin, timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250'
    });
    const evRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    const evData = await evRes.json();
    if (!evRes.ok) {
      console.error('Calendar events fetch failed:', evData);
      return res.status(502).json({ error: 'Could not read calendar events' });
    }
    const allEvents = evData.items || [];

    // 3) Keep only the events whose TITLE belongs to this doctor.
    const doctorEvents = allEvents.filter(ev => {
      const title = normalize(ev.summary || '');
      return title.includes(doctorLastName);
    });

    // 4) Turn those events' time ranges into the HH:MM slot labels the website understands.
    const duration = Number(slot_duration_minutes) || 20;
    const busySlots = [];
    for (let m = 10 * 60; m + duration <= 22 * 60; m += duration) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const slotStart = new Date(`${date}T${hh}:${mm}:00${CLINIC_UTC_OFFSET}`);
      const slotEnd = new Date(slotStart.getTime() + duration * 60000);
      const overlaps = doctorEvents.some(ev => {
        const evStart = new Date(ev.start.dateTime || ev.start.date);
        const evEnd = new Date(ev.end.dateTime || ev.end.date);
        return slotStart < evEnd && slotEnd > evStart;
      });
      if (overlaps) busySlots.push(`${hh}:${mm}`);
    }

    return res.status(200).json({ busy_slots: busySlots, doctor_events_found: doctorEvents.length });
  } catch (err) {
    console.error('Calendar availability check failed:', err);
    return res.status(500).json({ error: 'Calendar check failed' });
  }
}
