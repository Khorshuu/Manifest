import { z } from "zod";

/**
 * Input schemas for the auth routes. Unknown keys are rejected rather than
 * stripped, so a client sending an unexpected `role` field fails loudly
 * instead of being silently ignored (docs/SECURITY.md).
 */
export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    password: z.string().min(1, "Enter your password."),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1, "Enter your first name.")
      .max(60, "Use fewer than 60 characters."),
    lastName: z
      .string()
      .trim()
      .max(60, "Use fewer than 60 characters.")
      .optional()
      .transform((value) => (value ? value : undefined)),
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    phone: z
      .string()
      .trim()
      .regex(
        /^\+?[0-9]{10,15}$/,
        "Enter a phone number with 10 to 15 digits, optionally starting with +.",
      )
      .optional(),
    password: z
      .string()
      .min(10, "Use at least 10 characters.")
      .max(200, "Use fewer than 200 characters."),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
