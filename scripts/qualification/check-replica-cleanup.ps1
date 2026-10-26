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
            $i=[array]::IndexOf($a,'--name'); $name=$a[$i+1]
            if($m.mode -eq 'run' -or $m.mode -eq 'pinned-es-run' -or ($m.mode.EndsWith('broker-run') -and $name.EndsWith('-rabbit'))){throw 'Injected run failure'}
            if($m.mode -eq 'pinned-es-bind-conflict') {
                $saved=Get-Content -LiteralPath $m.stateFile -Raw|ConvertFrom-Json
                $port=[int]$saved.nodes[0].pinnedHttpPort
                if($a -notcontains "127.0.0.1:${port}:9200"){throw 'Docker bind differs from persisted Elasticsearch intent'}
                $competitor=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
                try { $competitor.ExclusiveAddressUse=$true; $competitor.Start(); throw 'Injected competing bind' }
                finally { $competitor.Stop() }
            }
            $cid=([string]($m.containers.Count+1))*64
            $m.containers[$cid]=@{name=$name;volume="$name-data"}; return $cid
        }
        'port' {
            if($m.mode -in @('port','pinned-es-port') -or $m.containers[$a[1]].name.EndsWith('-rabbit')){throw 'Injected port lookup failure'}
            return '127.0.0.1:39001'
        }
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
    foreach($mode in @('run','port','broker-run','broker-port','pinned-broker-run','pinned-broker-port',
        'pinned-es-run','pinned-es-port','pinned-es-bind-conflict')) {
        $reviewPath=Join-Path ([IO.Path]::GetTempPath()) ('es198-fixture-review-'+[guid]::NewGuid().ToString('N')+'.json')
        $global:ReviewDockerMock=@{mode=$mode;stateFile=$reviewPath;network=$null;volumes=@{};containers=@{};labels=@{};
            calls=[Collections.Generic.List[object]]::new();failRemoval=$false}
        try {
            $createError=$null
            $pin=$mode.StartsWith('pinned-broker-'); $elastic=$mode.StartsWith('pinned-es-'); $brokerFailure=$mode.Contains('broker-')
            try { $null=& $FixtureScript -Action create -StateFile $reviewPath -ExposeRabbitManagement -PinRabbitPorts:$pin -PinElasticsearchPorts:$elastic }
            catch { $createError=$_.Exception.Message }
            $expectedError=if($mode.EndsWith('run')){'Injected run failure'}elseif($mode.EndsWith('bind-conflict')){'Injected competing bind'}else{'Injected port lookup failure'}
            if($createError -ne $expectedError){throw "Expected exact injected create error, got: $createError"}
            $s=Get-Content -LiteralPath $reviewPath -Raw|ConvertFrom-Json
            if($s.nodes.Count -ne $(if($brokerFailure){3}else{1})){throw 'Intent not persisted before creation'}
            if(($mode -eq 'run' -or $elastic -and -not $mode.EndsWith('port')) -and $s.nodes[0].containerId){throw 'Run failure unexpectedly saved a CID'}
            if(($mode -eq 'port' -or $mode -eq 'pinned-es-port') -and -not $s.nodes[0].containerId){throw 'CID not saved before port lookup'}
            if($elastic) {
                $port=[int]$s.nodes[0].pinnedHttpPort
                $runs=@($global:ReviewDockerMock.calls | Where-Object { $_[0] -eq 'run' })
                if($runs.Count -ne 1 -or $port -le 1024 -or $port -gt 65535 -or
                    $s.nodes[0].url -ne "http://127.0.0.1:$port" -or $runs[0] -notcontains "127.0.0.1:${port}:9200"){
                    throw 'Pinned Elasticsearch intent changed or retried after failure'
                }
                $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
                try { $probe.ExclusiveAddressUse=$true; $probe.Start() } finally { $probe.Stop() }
            } elseif($s.nodes[0].pinnedHttpPort) {throw 'Ordinary fixture unexpectedly pinned Elasticsearch'}
            if($brokerFailure) {
                if(-not $s.broker -or $s.broker.volume -ne "$($s.broker.name)-data"){throw 'Broker intent not persisted before creation'}
                if([bool]$s.broker.containerId -ne $mode.EndsWith('port')){throw 'Broker CID persistence differs from the actual run outcome'}
                $brokerRun=@($global:ReviewDockerMock.calls | Where-Object { $_[0] -eq 'run' -and $_ -contains $s.broker.name })
                if($brokerRun.Count -ne 1){throw 'Expected exactly one attempted broker run'}
                $requested=@($brokerRun[0])
                if($pin) {
                    $ports=@($s.broker.pinnedPorts.amqp,$s.broker.pinnedPorts.management)
                    if($ports[0] -eq $ports[1]){throw 'Pinned ports collide'}
                    foreach($position in 0..1) {
                        $port=[int]$ports[$position]; $target=if($position -eq 0){5672}else{15672}
                        if($port -le 1024 -or $port -gt 65535 -or $requested -notcontains "127.0.0.1:${port}:$target"){
                            throw 'Pinned endpoint intent differs from the Docker bind request'
                        }
                        $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
                        try { $probe.ExclusiveAddressUse=$true; $probe.Start() } finally { $probe.Stop() }
                    }
                } elseif($s.broker.pinnedPorts -or $requested -notcontains '127.0.0.1::5672' -or $requested -notcontains '127.0.0.1::15672') {
                    throw 'Default fixture bindings changed'
                }
            }
            $global:ReviewDockerMock.labels=@{'io.eosrio.qualifier'='es198-replicas';'io.eosrio.run'=$s.run}
            $reviewResults.Add([pscustomobject]@{scenario=$mode;
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
    $invalidPath=Join-Path ([IO.Path]::GetTempPath()) ('es198-invalid-pin-'+[guid]::NewGuid().ToString('N')+'.json')
    $beforeCalls=$global:ReviewDockerMock.calls.Count
    foreach($invalidAction in @('create','cleanup')) {
        $failure=$null
        try { $null=& $FixtureScript -Action $invalidAction -StateFile $invalidPath -PinRabbitPorts }
        catch { $failure=$_.Exception.Message }
        if($failure -ne 'Pinned Rabbit ports require create with exposed management' -or (Test-Path -LiteralPath $invalidPath) -or
            $global:ReviewDockerMock.calls.Count -ne $beforeCalls){throw 'Invalid pin option performed fixture work'}
    }
    $reviewResults.Add([pscustomobject]@{scenario='invalid-pin-option-before-state-or-docker';passed=$true;realDockerCalls=0})
    $failure=$null
    try { $null=& $FixtureScript -Action cleanup -StateFile $invalidPath -PinElasticsearchPorts }
    catch { $failure=$_.Exception.Message }
    if($failure -ne 'Pinned Elasticsearch ports require create' -or (Test-Path -LiteralPath $invalidPath) -or
        $global:ReviewDockerMock.calls.Count -ne $beforeCalls){throw 'Invalid Elasticsearch pin option performed fixture work'}
    $reviewResults.Add([pscustomobject]@{scenario='invalid-elasticsearch-pin-before-state-or-docker';passed=$true;realDockerCalls=0})
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
