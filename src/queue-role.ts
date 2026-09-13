export type DeliveryQueueRole = "delivery" | "dead-letter" | "unknown";

export function deliveryQueueRole(
  queueName: string,
  names: { delivery: string; deadLetter: string },
): DeliveryQueueRole {
  if (queueName === names.delivery) return "delivery";
  if (queueName === names.deadLetter) return "dead-letter";
  return "unknown";
}
