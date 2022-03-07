import { featureFlags } from '../../featureFlags'

export interface FeatureFlagClient {
  variation<
    TFlag extends keyof typeof featureFlags,
    TValue extends typeof featureFlags[TFlag]['defaultValue'],
  >(flag: TFlag): Promise<TValue>
}
