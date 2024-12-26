import type { ActorRuntime } from "../../mod.ts";
import {
  ACTORS_API_SEGMENT,
  ACTORS_INVOKE_API_SEGMENT,
} from "../../runtime.ts";
import { ACTOR_ID_QS_NAME } from "../../stubutil.ts";

interface AlarmEntry {
  timestamp: number;
  actorId: string;
  actorName: string;
}

export class AlarmsManager {
  private storage: DurableObjectStorage;
  private readonly ALARMS_KEY = "actor_alarms";

  constructor(state: DurableObjectState, protected runtime: ActorRuntime) {
    this.storage = state.storage;
  }

  // Add a new alarm for an actor
  async scheduleActorAlarm(
    actorId: string,
    actorName: string,
    timestamp: number,
  ) {
    const alarms = await this.getAlarmsList();

    // Remove any existing alarm for this actor (considering both id and name)
    const filteredAlarms = alarms.filter(
      (alarm) => !(alarm.actorId === actorId && alarm.actorName === actorName),
    );

    // Add new alarm entry
    filteredAlarms.push({ timestamp, actorId, actorName });

    // Sort alarms by timestamp
    filteredAlarms.sort((a, b) => a.timestamp - b.timestamp);

    // Store updated alarms list
    await this.storage.put(this.ALARMS_KEY, filteredAlarms);

    // If this is the earliest alarm, schedule it
    if (filteredAlarms[0].timestamp === timestamp) {
      await this.storage.setAlarm(timestamp);
    }
  }

  // Get sorted list of alarms
  private async getAlarmsList(): Promise<AlarmEntry[]> {
    return (await this.storage.get(this.ALARMS_KEY)) || [];
  }

  // Handle alarm execution
  async alarm() {
    const currentTime = Date.now();
    const alarms = await this.getAlarmsList();

    // Find all alarms that should be triggered
    const [toTrigger, remaining] = alarms.reduce<[AlarmEntry[], AlarmEntry[]]>(
      ([trigger, remain], alarm) => {
        if (alarm.timestamp <= currentTime) {
          trigger.push(alarm);
        } else {
          remain.push(alarm);
        }
        return [trigger, remain];
      },
      [[], []],
    );

    // Trigger all relevant actors
    const triggerPromises = toTrigger.map(async (alarm) => {
      const url = new URL(
        `/${ACTORS_API_SEGMENT}/${alarm.actorName}/${ACTORS_INVOKE_API_SEGMENT}/alarm?${ACTOR_ID_QS_NAME}=${alarm.actorId}`,
        "http://localhost",
      );
      const response = await this.runtime.fetch(
        new Request(url, { method: "POST" }),
      );
      if (!response.ok) {
        throw new Error(
          `alarm error: ${await response.text()} ${response.status}`,
        );
      }
    });

    // Wait for all actors to be triggered
    await Promise.all(triggerPromises);

    // Update stored alarms list
    await this.storage.put(this.ALARMS_KEY, remaining);

    // Schedule next alarm if there are any remaining
    if (remaining.length > 0) {
      await this.storage.setAlarm(remaining[0].timestamp);
    } else {
      await this.storage.deleteAlarm();
    }
  }

  // Cancel an actor's alarm
  async cancelActorAlarm(actorId: string, actorName: string) {
    const alarms = await this.getAlarmsList();
    const filteredAlarms = alarms.filter(
      (alarm) => !(alarm.actorId === actorId && alarm.actorName === actorName),
    );

    await this.storage.put(this.ALARMS_KEY, filteredAlarms);

    // If we removed the earliest alarm, reschedule the next one
    if (
      filteredAlarms.length > 0 &&
      alarms[0].actorId === actorId &&
      alarms[0].actorName === actorName
    ) {
      await this.storage.setAlarm(filteredAlarms[0].timestamp);
    } else if (filteredAlarms.length === 0) {
      await this.storage.deleteAlarm();
    }
  }

  // Get the next scheduled alarm for an actor
  async getActorNextAlarm(
    actorId: string,
    actorName: string,
  ): Promise<number | null> {
    const alarms = await this.getAlarmsList();
    const actorAlarm = alarms.find(
      (alarm) => alarm.actorId === actorId && alarm.actorName === actorName,
    );
    return actorAlarm?.timestamp || null;
  }
}
