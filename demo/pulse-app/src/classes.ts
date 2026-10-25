export type ClassType = 'spin' | 'yoga' | 'boxing';

export const CLASS_INFO: Record<ClassType, { name: string; spots: number; minutes: number; blurb: string; unit: string }> = {
  spin: { name: 'Spin', spots: 12, minutes: 45, blurb: 'High-energy ride to a driving playlist.', unit: 'bike' },
  yoga: { name: 'Yoga', spots: 15, minutes: 60, blurb: 'Flow, stretch and reset your head.', unit: 'mat' },
  boxing: { name: 'Boxing', spots: 10, minutes: 50, blurb: 'Pads, combos and cardio. No experience needed.', unit: 'bag' },
};

// Weekly timetable. Day 0 = Sunday. Times are 24h local gym time.
const TIMETABLE: { type: ClassType; days: number[]; times: string[] }[] = [
  { type: 'spin', days: [1, 3, 5], times: ['06:30', '18:00'] },
  { type: 'yoga', days: [2, 4], times: ['07:00', '19:00'] },
  { type: 'yoga', days: [6], times: ['09:00'] },
  { type: 'boxing', days: [1, 4], times: ['18:45'] },
  { type: 'boxing', days: [6], times: ['10:30'] },
];

export type Session = { key: string; type: ClassType; startsAt: Date };

const pad = (n: number) => String(n).padStart(2, '0');

export function upcomingSessions(days = 14, now = new Date()): Session[] {
  const out: Session[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    for (const t of TIMETABLE) {
      if (!t.days.includes(day.getDay())) continue;
      for (const time of t.times) {
        const [h, m] = time.split(':').map(Number);
        const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (startsAt <= now) continue;
        const key = `${t.type}-${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}${pad(h)}${pad(m)}`;
        out.push({ key, type: t.type, startsAt });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export const dayLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
export const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
