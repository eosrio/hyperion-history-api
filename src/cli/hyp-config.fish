# Fish completion script for hyp-config
# Place this file in ~/.config/fish/completions/hyp-config.fish
# Version 2: Removed premature function erasure

# Main command
set -l command hyp-config

# Helper function to check if a command exists in the commandline buffer
function __fish_hyp_config_needs_command
    set -l cmd (commandline -opc)
    if [ (count $cmd) -eq 1 ]
        return 0
    end
    return 1
end

# Helper function to check if a specific subcommand was seen
function __fish_hyp_config_using_subcommand -a subcommand
    set -l cmd (commandline -opc)
    # Check if we have more than the base command and if the second element matches the subcommand
    if [ (count $cmd) -gt 1 ]
        if [ $cmd[2] = $subcommand ]
            return 0
        end
    end
    return 1
end

# --- Main Command Completions ---

# Top-level subcommands
complete -c $command -n '__fish_hyp_config_needs_command' -a 'connections' -d 'Manage infrastructure connections'
complete -c $command -n '__fish_hyp_config_needs_command' -a 'chains' -d 'Manage chain configurations'
complete -c $command -n '__fish_hyp_config_needs_command' -a 'contracts' -d 'Manage contract state configurations'
# Deprecated/Hidden commands (optional)
# complete -c $command -n '__fish_hyp_config_needs_command' -a 'list' -d '[Deprecated] List items'
# complete -c $command -n '__fish_hyp_config_needs_command' -a 'new' -d '[Deprecated] Create new items'
# complete -c $command -n '__fish_hyp_config_needs_command' -a 'remove' -d '[Deprecated] Remove items'


# --- Connections Subcommand ---

set -l connections_subcommand connections
complete -c $command -n "__fish_hyp_config_using_subcommand $connections_subcommand" -a 'init' -d 'Create and test the connections.json file'
complete -c $command -n "__fish_hyp_config_using_subcommand $connections_subcommand" -a 'test' -d 'Test connections to infrastructure'
complete -c $command -n "__fish_hyp_config_using_subcommand $connections_subcommand" -a 'reset' -d 'Remove the connections.json file'


# --- Chains Subcommand ---

set -l chains_subcommand chains
complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand" -a 'list' -d 'List configured chains (alias: ls)'
complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand; and contains list" -l 'valid' -d 'Only show valid chains'
complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand; and contains list" -l 'fix-missing-fields' -d 'Set defaults on missing fields'

complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand" -a 'new' -d 'Initialize new chain config'
complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand; and contains new" -l 'http' -r -d 'Define chain api http endpoint (e.g., http://localhost:8888)'
complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand; and contains new" -l 'ship' -r -d 'Define state history ws endpoint (e.g., ws://localhost:8080)'
# Argument <shortName> for 'new' - No specific completion, relies on user input or file completion

complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand" -a 'remove' -d 'Backup and delete chain configuration'
# Argument <shortName> for 'remove' - No specific completion

complete -c $command -n "__fish_hyp_config_using_subcommand $chains_subcommand" -a 'test' -d 'Test a chain configuration'
# Argument <shortName> for 'test' - No specific completion


# --- Contracts Subcommand ---

set -l contracts_subcommand contracts
complete -c $command -n "__fish_hyp_config_using_subcommand $contracts_subcommand" -a 'list' -d 'List contracts config for a chain'
# Argument <chainName> for 'list' - No specific completion

complete -c $command -n "__fish_hyp_config_using_subcommand $contracts_subcommand" -a 'add-single' -d 'Add/update single table config (indices as JSON)'
# Arguments <chainName> <account> <table> <autoIndex> <indices> for 'add-single'
complete -c $command -n "__fish_hyp_config_using_subcommand $contracts_subcommand; and contains add-single; and count (commandline -opc) -eq 6" -a 'true false' -d 'Auto index table (boolean)'

complete -c $command -n "__fish_hyp_config_using_subcommand $contracts_subcommand" -a 'add-multiple' -d 'Add/update multiple tables config (tables as JSON)'
# Arguments <chainName> <account> <tablesJson> for 'add-multiple'


# --- Deprecated Commands (Mirroring Structure) ---
# Omitted for brevity, but structure is similar if needed


# NOTE: The helper functions (__fish_hyp_config_needs_command and __fish_hyp_config_using_subcommand)
# are intentionally NOT removed with `functions -e` here.
# They need to persist for the completion logic to work correctly.
