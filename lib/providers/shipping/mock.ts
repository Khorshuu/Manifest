import { randomUUID } from "node:crypto";
import type {
  CreateShipmentInput,
  ShippingProvider,
  TrackingResult,
} from "./types";

/**
 * Development and test shipping provider.
 *
 * It returns a stable reference per order and a checkpoint list that grows as
 * staff record real movements, so the tracking view can be built and reviewed
 * before a courier account exists.
 */
export class MockShippingProvider implements ShippingProvider {
  readonly name = "mock";

  private readonly byOrder = new Map<string, string>();
  private readonly shipments = new Map<string, TrackingResult>();

  async createShipment(input: CreateShipmentInput) {
    const existing = this.byOrder.get(input.orderId);
    if (existing) {
      const shipment = this.shipments.get(existing)!;
      return {
        trackingReference: shipment.trackingReference,
        carrier: shipment.carrier,
      };
    }

    const trackingReference = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;

    this.byOrder.set(input.orderId, trackingReference);
    this.shipments.set(trackingReference, {
      trackingReference,
      carrier: "Mock Courier",
      checkpoints: [
        {
          status: "booked",
          description: "Delivery booked",
          location: input.city,
          occurredAt: new Date(),
        },
      ],
      estimatedDelivery: null,
    });

    return { trackingReference, carrier: "Mock Courier" };
  }

  async track(trackingReference: string): Promise<TrackingResult | null> {
    return this.shipments.get(trackingReference) ?? null;
  }

  /** Test helper: forget everything recorded so far. */
  reset(): void {
    this.byOrder.clear();
    this.shipments.clear();
  }
}
