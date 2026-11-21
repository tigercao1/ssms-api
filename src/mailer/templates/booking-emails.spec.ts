import { ConfigService } from '@nestjs/config';
import { MailerConfig } from '../mailer.config';
import type { BookingEmailVars } from '../mailer.types';
import { EmailRenderer } from './email-renderer';
import { bookingTime } from './email-templates';

const renderer = new EmailRenderer(
  new MailerConfig({
    get: (key: string) => ({ PORTAL_URL: 'https://portal.example.com' })[key],
  } as unknown as ConfigService),
);

const LESSON = {
  startsAt: '2026-12-12T15:00:00.000Z',
  endsAt: '2026-12-12T16:00:00.000Z',
};
const PREVIOUS = {
  startsAt: '2026-12-11T20:00:00.000Z',
  endsAt: '2026-12-11T21:00:00.000Z',
};

const vars: BookingEmailVars = {
  displayName: 'Mei',
  lessonNameEn: 'Private 1h',
  lessonNameZh: '私教1小时',
  instructorNameEn: 'Amy',
  instructorNameZh: '艾米',
  customerNames: ['Mei Wang', 'Leo Chen'],
  location: 'Blue Mountain',
  lessons: [LESSON],
};

describe('booking emails', () => {
  it('formats lesson times in Toronto time per language', () => {
    expect(bookingTime(LESSON, 'en')).toMatch(
      /^Sat, Dec 12, 2026, 10:00\s–\s11:00\sAM$/u,
    );
    expect(bookingTime(LESSON, 'zh-CN')).toContain('2026年12月12日');
    expect(bookingTime(LESSON, 'zh-CN')).toMatch(/10:00\s?–\s?11:00/u);
  });

  it.each([
    ['booking.confirmed.customer', 'Your lesson is booked: Private 1h'],
    ['booking.cancelled.customer', 'Your lesson is cancelled: Private 1h'],
    ['booking.confirmed.instructor', 'New lesson booked: Private 1h'],
    ['booking.cancelled.instructor', 'Lesson cancelled: Private 1h'],
  ] as const)(
    '%s renders the subject and lesson details',
    (template, subject) => {
      const email = renderer.render(template, 'en', vars);
      expect(email.subject).toBe(subject);
      expect(email.text).toContain('Hi Mei');
      expect(email.text).toContain(
        `• ${bookingTime(LESSON, 'en')} (Toronto time)`,
      );
      expect(email.text).toContain('Location: Blue Mountain');
    },
  );

  it('names the instructor for customers and the students for instructors', () => {
    const customer = renderer.render('booking.confirmed.customer', 'en', vars);
    expect(customer.text).toContain('Your Private 1h with Amy is booked for:');
    expect(customer.text).toContain('Instructor: Amy');
    expect(customer.text).not.toContain('Students:');

    const instructor = renderer.render(
      'booking.confirmed.instructor',
      'en',
      vars,
    );
    expect(instructor.text).toContain('Students: Mei Wang, Leo Chen');
    expect(instructor.text).not.toContain('Instructor:');
  });

  it('lists every lesson of a series', () => {
    const second = {
      startsAt: '2026-12-19T15:00:00.000Z',
      endsAt: '2026-12-19T16:00:00.000Z',
    };
    const email = renderer.render('booking.confirmed.customer', 'en', {
      ...vars,
      lessons: [LESSON, second],
    });
    expect(email.text).toContain(bookingTime(LESSON, 'en'));
    expect(email.text).toContain(bookingTime(second, 'en'));
  });

  it('shows the previous time on a reschedule', () => {
    const email = renderer.render('booking.rescheduled.customer', 'en', {
      ...vars,
      previous: [PREVIOUS],
    });
    expect(email.subject).toBe('Your lesson was rescheduled: Private 1h');
    const text = email.text;
    expect(text.indexOf(bookingTime(LESSON, 'en'))).toBeLessThan(
      text.indexOf('Previously:'),
    );
    expect(text.indexOf('Previously:')).toBeLessThan(
      text.indexOf(bookingTime(PREVIOUS, 'en')),
    );
  });

  it('leaves out the previous block when only the instructor changed', () => {
    const email = renderer.render('booking.rescheduled.instructor', 'en', {
      ...vars,
      previous: [],
    });
    expect(email.text).not.toContain('Previously:');
  });

  it('says what changed and keeps the unchanged time on an update', () => {
    const email = renderer.render('booking.updated.instructor', 'en', {
      ...vars,
      location: 'Mount St. Louis',
      changes: {
        addedCustomers: ['Leo Chen'],
        removedCustomers: ['Ann Li'],
        location: { previous: 'Blue Mountain' },
        lessonType: { previousEn: 'Group 90', previousZh: null },
      },
    });
    expect(email.subject).toBe('Lesson updated: Private 1h');
    expect(email.text).not.toMatch(/reschedul/i);
    expect(email.text).not.toContain('Previously:');
    expect(email.text).toContain(
      'Your Private 1h was updated. The time has not changed:',
    );
    expect(email.text).toContain(
      `• ${bookingTime(LESSON, 'en')} (Toronto time)`,
    );
    expect(email.text).toContain('Added: Leo Chen');
    expect(email.text).toContain('Removed: Ann Li');
    expect(email.text).toContain(
      'Location changed (previously Blue Mountain).',
    );
    expect(email.text).toContain('Lesson type changed (previously Group 90).');
    expect(email.text).toContain('Location: Mount St. Louis');
  });

  it('renders the update in zh-CN and leaves out empty change lines', () => {
    const email = renderer.render('booking.updated.instructor', 'zh-CN', {
      ...vars,
      changes: {
        addedCustomers: [],
        removedCustomers: ['Ann Li'],
        location: { previous: null },
      },
    });
    expect(email.subject).toBe('课程已更新：私教1小时');
    expect(email.text).not.toContain('改期');
    expect(email.text).toContain('您的私教1小时信息已更新，上课时间不变：');
    expect(email.text).toContain('移除学员：Ann Li');
    expect(email.text).not.toContain('新增学员');
    expect(email.text).toContain('地点已更改（原地点：未设置）。');
    expect(email.text).not.toContain('课程类型已更改');
  });

  it('tells a customer what changed without naming other customers', () => {
    const email = renderer.render('booking.updated.customer', 'en', {
      ...vars,
      customerNames: [],
      instructorNameEn: 'Ben',
      instructorNameZh: null,
      changes: {
        lessonType: { previousEn: 'Group 90', previousZh: null },
        instructor: { previousEn: 'Amy', previousZh: '艾米' },
      },
    });
    expect(email.subject).toBe('Your lesson was updated: Private 1h');
    expect(email.text).not.toMatch(/reschedul/i);
    expect(email.text).not.toContain('Previously:');
    expect(email.text).toContain(
      'Your Private 1h with Ben was updated. The time has not changed:',
    );
    expect(email.text).toContain(
      `• ${bookingTime(LESSON, 'en')} (Toronto time)`,
    );
    expect(email.text).toContain('Lesson type changed (previously Group 90).');
    expect(email.text).toContain('Instructor changed (previously Amy).');
    expect(email.text).toContain('Instructor: Ben');
    expect(email.text).not.toMatch(/Added|Removed|Students/);
    expect(email.text).not.toContain('Leo');
  });

  it('renders the customer update in zh-CN with the SSnow brand', () => {
    const email = renderer.render('booking.updated.customer', 'zh-CN', {
      ...vars,
      customerNames: [],
      changes: { location: { previous: '  ' } },
    });
    expect(email.subject).toBe('课程已更新：私教1小时');
    expect(email.text).not.toContain('改期');
    expect(email.text).toContain(
      '您与 艾米 的私教1小时信息已更新，上课时间不变：',
    );
    expect(email.text).toContain('地点已更改（原地点：未设置）。');
    expect(email.text).not.toContain('课程类型已更改');
    expect(email.text).not.toContain('教练已更换');
    expect(email.text).toContain('是因为有人在 SSnow 为您预约了课程。');
  });

  it('renders zh-CN with the Chinese lesson and instructor names', () => {
    const email = renderer.render('booking.confirmed.customer', 'zh-CN', vars);
    expect(email.subject).toBe('课程已预约：私教1小时');
    expect(email.text).toContain('您与 艾米 的私教1小时已预约在：');
    expect(email.text).toContain('（多伦多时间）');
    expect(email.text).toContain('教练： 艾米');
  });

  it('falls back to English names in zh-CN and skips a blank location', () => {
    const email = renderer.render('booking.cancelled.instructor', 'zh-CN', {
      ...vars,
      lessonNameZh: null,
      location: '  ',
    });
    expect(email.subject).toBe('课程已取消：Private 1h');
    expect(email.text).not.toContain('地点：');
  });

  it('renders lesson reminders without a calendar file note', () => {
    const customer = renderer.render('booking.reminder.customer', 'en', {
      ...vars,
      customerNames: [],
    });
    expect(customer.subject).toBe('Reminder: your Private 1h with Amy');
    expect(customer.text).toContain(
      `• ${bookingTime(LESSON, 'en')} (Toronto time)`,
    );
    expect(customer.text).toContain('Instructor: Amy');
    expect(customer.text).toContain('Location: Blue Mountain');
    expect(customer.text).not.toContain('calendar file');

    const instructor = renderer.render(
      'booking.reminder.instructor',
      'zh-CN',
      vars,
    );
    expect(instructor.subject).toBe('课程提醒：私教1小时');
    expect(instructor.text).toContain('学员： Mei Wang, Leo Chen');
    expect(instructor.text).not.toContain('日历文件');
  });

  it('renders bilingual with both blocks', () => {
    const email = renderer.render(
      'booking.rescheduled.instructor',
      'bilingual',
      { ...vars, previous: [PREVIOUS] },
    );
    expect(email.subject).toBe(
      'Lesson rescheduled: Private 1h / 课程已改期：私教1小时',
    );
    expect(email.text).toContain('Previously:');
    expect(email.text).toContain('原时间：');
  });
});
