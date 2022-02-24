export enum FeatureFlagName {
  IsQueryingByBlockNumberEnabled = 'is_querying_by_block_number_enabled',
  IsQueryingTokenValueEnabled = 'is_querying_token_value_enabled',
}

interface FeatureFlags {
  [x: string]: { defaultValue: string | number | boolean }
}

export const featureFlags: FeatureFlags = {
  [FeatureFlagName.IsQueryingByBlockNumberEnabled]: { defaultValue: false },
  [FeatureFlagName.IsQueryingTokenValueEnabled]: { defaultValue: false },
}
