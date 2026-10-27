import { z } from 'zod';

export const loginEventSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('waiting'),
    image: z
      .string()
      .max(500000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
    expiresAt: z.number().int().positive(),
  }),
  z.strictObject({ state: z.enum(['scanned', 'success', 'expired', 'risk', 'error']) }),
]);
export type LoginState =
  | 'idle'
  | 'starting'
  | 'cancelled'
  | z.infer<typeof loginEventSchema>['state'];
export interface LoginView {
  available: boolean;
  savedSession: boolean;
  state: LoginState;
  message: string;
  sessionId?: string;
  image?: string;
  expiresAt?: number;
  searchBlocked?: boolean;
}
export const loginCancelSchema = z.strictObject({ sessionId: z.uuid() });
export const loginActive = (state: LoginState) =>
  ['starting', 'waiting', 'scanned'].includes(state);
