/**
 * Shipping and tracking provider interface.
 *
 * MASTER_PRODUCT_SPEC.md section 7 defers a real courier integration but asks
 * for the abstraction, so every call site talks to this and a courier API
 * slots in later without any of them changing.
 */

export type TrackingCheckpoint = {
  status: string;
  description: string;
  location: string | null;
  occurredAt: Date;
};

export type TrackingResult = {
  trackingReference: string;
  carrier: string;
  checkpoints: TrackingCheckpoint[];
  /** Null when the carrier gives no estimate. */
  estimatedDelivery: Date | null;
};

export type CreateShipmentInput = {
  orderId: string;
  orderNumber: string;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  district: string;
  postalCode: string | null;
  /** Total weight in grams, for carriers that price by weight. */
  weightGrams: number;
};

export interface ShippingProvider {
  readonly name: string;
  /** Books the delivery and returns the reference a shopper can track. */
  createShipment(input: CreateShipmentInput): Promise<{
    trackingReference: string;
    carrier: string;
  }>;
  track(trackingReference: string): Promise<TrackingResult | null>;
}
