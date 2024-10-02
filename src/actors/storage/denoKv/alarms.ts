import { actors } from "../../proxy.ts";
import { kv } from "./storage.ts";

function minutesNow(timestamp = Date.now()): number {
  const date = new Date(timestamp);

  // Set seconds and milliseconds to zero to floor to the start of the next minute
  date.setSeconds(0, 0);

  // Add one minute (60,000 milliseconds)
  const nextMinute = new Date(date.getTime() + 60 * 1000);

  // Subtract 1 millisecond to get the last millisecond of the current minute
  return nextMinute.getTime() - 1;
}

export interface Alarm extends CreateAlarmPayload {
  id: string;
  retries?: Retry[];
}
export interface CreateAlarmPayload {
  actorName: string;
  actorId: string;
  triggerAt: number;
}
export interface Retry {
  reason: string;
}
const TRIGGERS = ["triggers"];
const ALARMS = ["alarms"];
export const Alarms = {
  id: (alarm: Omit<CreateAlarmPayload, "triggerAt">) =>
    `${alarm.actorName}:${alarm.actorId}`,
  schedule: async (payload: CreateAlarmPayload): Promise<Alarm> => {
    const id = Alarms.id(payload);
    const currentAlarm = await Alarms.get(payload);

    const triggerKey = [...TRIGGERS, payload.triggerAt, id];
    const alarm = { ...payload, id };
    let transaction = kv.atomic().set(triggerKey, alarm).check(currentAlarm);
    if (currentAlarm.versionstamp !== null && currentAlarm.value) {
      transaction = transaction.delete([
        ...TRIGGERS,
        currentAlarm.value.triggerAt,
        id,
      ]);
    }
    await Alarms.set(payload, transaction);
    await transaction.commit();
    return alarm;
  },
  get: async (payload: Omit<CreateAlarmPayload, "triggerAt">) => {
    const id = Alarms.id(payload);
    const key = [...ALARMS, id];
    const result = await kv.get<Alarm>(key);
    return result;
  },
  set: async (
    payload: Omit<CreateAlarmPayload, "triggerAt"> | Alarm,
    denoKv: { set: Deno.Kv["set"] | Deno.AtomicOperation["set"] } = kv,
  ) => {
    const id = Alarms.id(payload);
    const alarm = { ...payload, id };
    const key = [...ALARMS, id];
    const result = denoKv.set(key, alarm);
    if (result instanceof Deno.AtomicOperation) {
      return;
    }
    const awaited = await result;
    if (awaited.ok) {
      throw new Error(`alarm could not be created`);
    }
    return {
      key,
      value: alarm,
      versionstamp: awaited.versionstamp,
    };
  },
  ack: async (
    alarm: Alarm | Omit<CreateAlarmPayload, "triggerAt">,
  ): Promise<void> => {
    const id = Alarms.id(alarm);
    const triggerAt = "triggerAt" in alarm
      ? alarm.triggerAt
      : (await Alarms.get(alarm)).value?.triggerAt;
    if (!triggerAt) {
      throw new Error(`alarm ${id} has no triggerAt`);
    }

    await kv.atomic().delete([...ALARMS, id]).delete([
      ...TRIGGERS,
      triggerAt,
      id,
    ]).commit();
  },
  retry: async (alarm: Alarm, reason: string): Promise<void> => {
    const savedAlarm = await Alarms.get(alarm);

    const transaction = kv.atomic().check(savedAlarm);
    await Alarms.set({
      ...alarm,
      retries: [...alarm.retries ?? [], { reason }],
    }, transaction);
    await transaction
      .commit();
  },
  getRetries: async (alarm: Alarm): Promise<Retry[] | undefined> => {
    const retry = await Alarms.get(alarm);
    return retry?.value?.retries;
  },
  next: async function* (): AsyncIterableIterator<Alarm> {
    const selector = {
      prefix: TRIGGERS,
      end: [...TRIGGERS, minutesNow()],
    };
    const iter = kv.list<Alarm>(selector);

    for await (const alarm of iter) yield alarm.value;
  },
};

const tryAck = async (alarm: Alarm): Promise<void> => {
  try {
    const proxy = actors.proxy<{ alarm: () => Promise<void> }>(
      alarm.actorName,
    ).id(alarm.actorId);
    await proxy.alarm();
    await Alarms.ack(alarm);
  } catch (error) {
    const retries = await Alarms.getRetries(alarm);
    if (retries === undefined) {
      console.error(`retrying ${alarm}`, error);
      await Alarms.retry(alarm, (error as Error).message);
    } else if (retries?.length === 10) {
      console.error(`retrying ${alarm}`, error, retries);
      await Alarms.ack(alarm);
    }
  }
};

const inflight: Record<string, Promise<void>> = {};

export const triggerAlarms = async () => {
  for await (const alarm of Alarms.next()) {
    inflight[alarm.id] ??= tryAck(alarm).finally(() =>
      delete inflight[alarm.id]
    );
  }
  await Promise.all(Object.values(inflight));
};
// TODO (@author M. Candeia): this will make all isolates to spin up every 1 minute, would this be a problem?
// Shouldn't instead have a single job that spin ups isolates if they need to be called instead?
// On the other hand it is good because it works locally and remotelly in the same way.
Deno.cron("schedulerD", "* * * * *", triggerAlarms);
