param(
    [string]$FixtureScript=(Join-Path $PSScriptRoot 'es955-replica-fixture.ps1'),
    [string]$OutputFile
)
$ErrorActionPreference='Stop'
$FixtureScript=(Resolve-Path -LiteralPath $FixtureScript).Path
if ((Get-Command docker -ErrorAction SilentlyContinue).CommandType -in @('Alias','Function')) {
    throw 'Run this audit in a fresh PowerShell process so no existing Docker function is replaced'
}
$reviewResults=[Collections.Generic.List[object]]::new()
$mockLogs=[Collections.Generic.List[object]]::new()

# This function intercepts every Docker invocation made by the real fixture script.
# No fallback to a Docker executable exists in any branch.
function global:docker {
    $global:LASTEXITCODE=0
    $a=@($args)
    $m=$global:ReviewDockerMock
    $m.calls.Add($a)
    switch($a[0]) {
        'network' {
            switch($a[1]) {
                'create' { $m.network=$a[-1]; return $m.network }
                'ls' { if($m.network){return $m.network}; return }
                'inspect' {
                    $ends=@{}
                    foreach($k in $m.containers.Keys){$ends[$k]=@{Name=$m.containers[$k].name}}
                    return (@{Name=$m.network;Labels=$m.labels;Containers=$ends}|ConvertTo-Json -Depth 6 -Compress)
                }
                'rm' { $m.network=$null; return 'removed' }
                default { throw ('Unexpected mock network command '+($a -join ' ')) }
            }
        }
        'volume' {
            switch($a[1]) {
                'create' { $m.volumes[$a[-1]]=$true; return $a[-1] }
                'ls' { return @($m.volumes.Keys) }
                'inspect' { return (@{Name=$a[-1];Labels=$m.labels}|ConvertTo-Json -Depth 4 -Compress) }
                'rm' {
                    if($m.failRemoval){$m.failRemoval=$false;throw 'Injected interrupted volume removal'}
                    $m.volumes.Remove($a[-1]); return 'removed'
                }
                default { throw ('Unexpected mock volume command '+($a -join ' ')) }
            }
        }
        'run' {
            if($m.mode -eq 'run'){throw 'Injected run failure'}
            $i=[array]::IndexOf($a,'--name'); $name=$a[$i+1]; $cid='a'*64
            $m.containers[$cid]=@{name=$name;volume="$name-data"}; return $cid
        }
        'port' { throw 'Injected port lookup failure' }
        'ps' {
            $i=[array]::IndexOf($a,'--filter'); $filter=$a[$i+1]
            $f=[array]::IndexOf($a,'--format')
            foreach($k in @($m.containers.Keys)){
                $c=$m.containers[$k]
                if($filter.StartsWith('volume=') -and $filter.Substring(7) -ne $c.volume){continue}
                if($a[$f+1] -eq '{{.ID}}|{{.Names}}'){ "$k|$($c.name)" }else{ $k }
            }
            return
        }
        'inspect' {
            $cid=$a[-1]; $c=$m.containers[$cid]
            return (@{Id=$cid;Name='/'+$c.name;Config=@{Labels=$m.labels}}|ConvertTo-Json -Depth 5 -Compress)
        }
        'rm' { $m.containers.Remove($a[-1]); return 'removed' }
        default { throw ('Unexpected mock command '+($a -join ' ')) }
    }
}

try {
    foreach($mode in @('run','port')) {
        $reviewPath=Join-Path ([IO.Path]::GetTempPath()) ('es198-fixture-review-'+[guid]::NewGuid().ToString('N')+'.json')
        $global:ReviewDockerMock=@{mode=$mode;network=$null;volumes=@{};containers=@{};labels=@{};
            calls=[Collections.Generic.List[object]]::new();failRemoval=$false}
        try {
            $createError=$null
            try { $null=& $FixtureScript -Action create -StateFile $reviewPath }
            catch { $createError=$_.Exception.Message }
            $expectedError=if($mode -eq 'run'){'Injected run failure'}else{'Injected port lookup failure'}
            if($createError -ne $expectedError){throw "Expected exact injected create error, got: $createError"}
            $s=Get-Content -LiteralPath $reviewPath -Raw|ConvertFrom-Json
            if($s.nodes.Count -ne 1){throw 'Intent not persisted before creation'}
            if($mode -eq 'run' -and $s.nodes[0].containerId){throw 'Run failure unexpectedly saved a CID'}
            if($mode -eq 'port' -and -not $s.nodes[0].containerId){throw 'CID not saved before port lookup'}
            $global:ReviewDockerMock.labels=@{'io.eosrio.qualifier'='es198-replicas';'io.eosrio.run'=$s.run}
            $reviewResults.Add([pscustomobject]@{scenario=if($mode -eq 'run'){'run-failure-after-network-and-volume'}else{'port-failure-after-container-created'};
                passed=$true;creationFailure=$createError;persistedIntents=$s.nodes.Count;
                cidPersisted=[bool]$s.nodes[0].containerId;realDockerCalls=0})
            if($mode -eq 'port') {
                $global:ReviewDockerMock.failRemoval=$true
                $cleanupError=$null
                try { $null=& $FixtureScript -Action cleanup -StateFile $reviewPath }
                catch { $cleanupError=$_.Exception.Message }
                if($cleanupError -ne 'Injected interrupted volume removal'){throw "Expected exact interrupted cleanup error, got: $cleanupError"}
                if($global:ReviewDockerMock.containers.Count -ne 0 -or $global:ReviewDockerMock.volumes.Count -ne 1){
                    throw 'Expected interrupted cleanup to preserve the volume after removing its container'
                }
                $null=& $FixtureScript -Action cleanup -StateFile $reviewPath
                $reviewResults.Add([pscustomobject]@{scenario='interrupted-cleanup-retry';passed=$true;
                    interruptedAfterContainerRemoval=$true;remainingContainers=$global:ReviewDockerMock.containers.Count;
                    remainingVolumes=$global:ReviewDockerMock.volumes.Count;remainingNetworks=[int][bool]$global:ReviewDockerMock.network;realDockerCalls=0})
            } else { $null=& $FixtureScript -Action cleanup -StateFile $reviewPath }
            $null=& $FixtureScript -Action cleanup -StateFile $reviewPath
            if($global:ReviewDockerMock.containers.Count -or $global:ReviewDockerMock.volumes.Count -or $global:ReviewDockerMock.network){
                throw 'Mock resources remain after repeated cleanup'
            }
            $mockLogs.Add([pscustomobject]@{creationFailureMode=$mode;calls=$global:ReviewDockerMock.calls.ToArray();
                repeatedCleanupPassed=$true;remainingContainers=0;remainingVolumes=0;remainingNetworks=0})
        } finally {
            foreach($p in @($reviewPath,$reviewPath+'.cleanup.json')){
                if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p}
            }
        }
    }
    $reviewResults.Add([pscustomobject]@{scenario='repeated-cleanup-idempotency';passed=$true;
        runFailureRepeatedCleanup=$true;portFailureRepeatedCleanup=$true;realDockerCalls=0})
    $report=[ordered]@{schemaVersion=1;status='passed';fixtureScript=$FixtureScript;
        fixtureScriptSha256=(Get-FileHash -LiteralPath $FixtureScript -Algorithm SHA256).Hash.ToLowerInvariant();
        testScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();
        realDockerCalls=0;scenarioCount=$reviewResults.Count;scenarios=$reviewResults.ToArray();
        mockCallLogs=$mockLogs.ToArray();completedAt=[DateTime]::UtcNow.ToString('o')}
    $json=($report|ConvertTo-Json -Depth 15)+"`n"
    if($OutputFile){[IO.File]::WriteAllText($OutputFile,$json,[Text.UTF8Encoding]::new($false))}
    Write-Output $json
} finally {
    Remove-Item function:\docker
    Remove-Variable ReviewDockerMock -Scope Global -ErrorAction SilentlyContinue
}
