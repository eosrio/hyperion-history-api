import { LDClient, LDUser } from 'launchdarkly-node-server-sdk'

import { featureFlags } from '../../featureFlags'
import {
  FeatureFlagClient,
} from './FeatureFlagClient'

export const LDUserCustomProperties = {
  platform: 'hyperion',
}

export const LDAnonymousUser = {
  anonymous: true,
  custom: LDUserCustomProperties,
  key: 'anonymous',
}

export class LaunchDarklyClient implements FeatureFlagClient {
  constructor(
    private launchdarkly: LDClient,
  ) {}

  public async variation<
    TFlag extends keyof typeof featureFlags,
    TValue extends typeof featureFlags[TFlag]['defaultValue'],
  >(flag: TFlag): Promise<TValue> {
    const defaultValue = featureFlags[flag].defaultValue

    // once actual feature flags are defined, get rid of this `${ }`
    return this.launchdarkly.variation(`${flag}`, LDAnonymousUser, defaultValue)
  }
}
