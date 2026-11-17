<template>
  <TabsRoot v-if="open" v-model="activeTab" as="section" activation-mode="manual"
    :dir="getDirection() === 'rtl' ? 'rtl' : 'ltr'" class="project-settings-panel" :aria-label="t('settings.title')">
        <header class="workspace-panel-header settings-header">
          <h2 class="workspace-panel-header__title">{{ t(filePicker === 'standby' ? 'settings.videoOutputStandbyImage' : 'settings.title') }}</h2>
          <TabsList class="settings-tabs" :aria-label="t('settings.title')">
            <TabsTrigger
              v-for="tab in tabs"
              :key="tab.id"
              :value="tab.id"
              class="tab-btn"
              :title="tab.label"
              :aria-label="tab.id === 'about' && update.version ? `${tab.label}, ${t('update.updateAvailable')}` : undefined"
              @click="activeTab = tab.id"
            >
              <CueSymbol v-if="tab.symbol" :name="tab.symbol" />
              <span v-else class="material-symbols-rounded" aria-hidden="true">{{ tab.icon }}</span>
              <span class="settings-tab-label">{{ tab.label }}</span>
              <span v-if="tab.id === 'about' && update.version" class="update-dot" aria-hidden="true"></span>
            </TabsTrigger>
          </TabsList>
          <button type="button" class="close-x" :aria-label="t('actions.close')" @click="close">
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </header>

    <TabsContent v-for="tab in tabs" :key="tab.id" :value="tab.id" class="settings-tabpanel">
      <template v-if="tab.id === activeTab">
        <ControlConfigModal v-if="activeTab === 'shortcuts' || activeTab === 'midi'"
          :mode="activeTab === 'midi' ? 'midi' : 'keyboard'" />
        <ServerFilePickerModal v-else-if="activeTab === 'video' && filePicker === 'standby'" docked :open="true"
          filter=".png,.jpg,.jpeg,.webp,.gif,.svg" :filter-options="[]"
          :fallback-start-path="currentProject?.folderPath" location-context="standby-image"
          @pick="onVideoOutputStandbyPicked" @close="closeStandbyImagePicker" />
        <div v-else :class="['settings-content', `settings-content--${activeTab}`]">
          <p v-if="settingsError" class="settings-error" role="alert">
            {{ settingsError }}
          </p>
          <!-- ================= Audio Routing ================= -->
          <template v-if="activeTab === 'audio'">
            <!-- The two checks before a show. They open from here, beside the
                 audio set-up they are about, and stay out of the top bar. -->
            <div v-if="currentProject" class="settings-rows show-checks">
              <section class="settings-field show-checks__row">
                <button type="button" class="modal-btn" aria-controls="workspace-import-host"
                  @click="openShowCheck">{{ t('showCheck.title') }}</button>
                <p class="settings-help">{{ t('showCheck.hint') }}</p>
              </section>
              <section class="settings-field show-checks__row">
                <button type="button" class="modal-btn" :class="{ 'modal-btn--on': levelCheckActive }"
                  :aria-pressed="levelCheckActive" :disabled="levelCheckCount === 0"
                  @click="toggleLevelCheck">{{ t('levelCheck.title') }}</button>
                <p class="settings-help">{{ t(levelCheckCount === 0 ? 'levelCheck.unavailable' : 'levelCheck.hint') }}</p>
              </section>
            </div>
            <!-- Audio device (default for cue playback) -->
            <section class="settings-field">
              <span class="settings-label">{{ t('settings.audioDevice') }}</span>
              <div class="audio-routing-choice">
                <InlineChoicePicker id="settings-audio-device" :label="t('settings.audioDevice')"
                  :value="audioDeviceId" :options="audioDeviceOptions" @change="onAudioDeviceChange" />
                <p class="settings-help">{{ t('settings.audioDeviceHelp') }}</p>
              </div>
            </section>

            <!-- Preview stores the stable hardware name; opened-device ids are session-scoped. -->
            <section class="settings-field">
              <span class="settings-label">{{ t('settings.previewDevice') }}</span>
              <div class="audio-routing-choice">
                <InlineChoicePicker id="settings-preview-device" :label="t('settings.previewDevice')"
                  :value="previewDeviceId" :options="audioDeviceOptions" @change="onPreviewDeviceChange" />
                <p class="settings-help">{{ t('settings.previewDeviceHelp') }}</p>
              </div>
            </section>

            <!-- LTC device (timecode output) -->
            <section class="settings-field">
              <span class="settings-label">{{ t('settings.ltcDevice') }}</span>
              <div class="audio-routing-choice">
                <InlineChoicePicker id="settings-ltc-device" :label="t('settings.ltcDevice')"
                  :value="ltcDeviceId" :options="audioDeviceOptions" @change="onLtcDeviceChange" />
                <p class="settings-help">{{ t('settings.ltcDeviceHelp') }}</p>
              </div>
            </section>

            <!-- Output Target (loudness platform standard) -->
            <section class="settings-field">
              <span class="settings-label">{{ t('settings.outputTarget') }}</span>
              <div class="audio-routing-choice">
                <InlineChoicePicker id="settings-output-target" :label="t('settings.outputTarget')"
                  :value="outputTarget" :options="outputTargetOptions" @change="onOutputTargetChange" />
                <p class="settings-help">{{ t('settings.outputTargetHelp') }}</p>
              </div>
            </section>
          </template>

          <!-- ================= Playback Behaviour ================= -->
          <template v-else-if="activeTab === 'playback'">
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.cueingSection') }}</h3>
              <section class="settings-field">
                <span class="settings-label">
                  {{ t('settings.transitionMode') }}
                </span>
                <InlineChoicePicker id="settings-transition" :label="t('settings.transitionMode')"
                  :value="defaultTransitionMode" :options="transitionModeOptions" @change="onDefaultTransitionModeChange" />
                <p class="settings-help">{{ t('settings.transitionModeHelp') }}</p>
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="autoCueNextWithoutEndBehavior"
                    @change="onAutoCueNextChange"
                  />
                  {{ t('settings.autoCueNext') }}
                </label>
                <p class="settings-help">{{ t('settings.autoCueNextHelp') }}</p>
              </section>
              <section class="settings-field">
                <span class="settings-label">{{ t('musicContinuity.backup') }}</span>
                <InlineChoicePicker id="settings-music-backup" :label="t('musicContinuity.backup')"
                  :value="configuredMusicBackup" :options="musicBackupOptions"
                  :disabled="projectHydrationStatus !== 'ready' || musicContinuityPending.has('')"
                  @change="changeMusicBackup" />
                <p class="settings-help">{{ t('musicContinuity.help') }}</p>
              </section>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.safetySection') }}</h3>
              <section class="settings-field">
                <label class="settings-label" for="settings-stop-fade">
                  {{ t('settings.stopAllFade') }}
                </label>
                <input
                  type="number"
                  id="settings-stop-fade" class="settings-input"
                  min="0"
                  step="0.1"
                  :value="stopAllFadeSeconds"
                  @change="onStopAllFadeChange"
                />
                <p class="settings-help">{{ t('settings.stopAllFadeHelp') }}</p>
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="disableLimiter"
                    @change="onDisableLimiterChange"
                  />
                  {{ t('settings.disableLimiter') }}
                </label>
                <p class="settings-help">{{ t('settings.disableLimiterHelp') }}</p>
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="disableSilenceWarning"
                    @change="onDisableSilenceWarningChange"
                  />
                  {{ t('settings.disableSilenceWarning') }}
                </label>
              </section>
            </div>
            <div class="settings-rows settings-rows--wide">
              <h3 class="settings-section-title">{{ t('backups.title') }}</h3>
              <section class="settings-field">
                <p class="settings-help">{{ t('backups.help') }}</p>
                <ShowBackupsList />
              </section>
            </div>
          </template>

          <!-- ================= User Interface ================= -->
          <template v-else-if="activeTab === 'ui'">
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.appearanceSection') }}</h3>
              <section class="settings-field">
                <span class="settings-label">{{ t('colors.chooseAccent') }}</span>
                <div class="accent-swatches" role="group" :aria-label="t('colors.chooseAccent')">
                  <button v-for="color in accentColors" :key="color" type="button" class="accent-swatch"
                    :style="{ backgroundColor: color }" :title="color" :aria-label="color"
                    :aria-pressed="selectedAccent === color"
                    :disabled="projectHydrationStatus !== 'ready'" @click="setAccentColor(color)" />
                </div>
              </section>
              <section class="settings-field track-height-control">
                <label for="ui-font-scale">{{ t('settings.interfaceFontSize') }}</label>
                <input
                  id="ui-font-scale"
                  type="range"
                  :min="UI_FONT_SCALE.min"
                  :max="UI_FONT_SCALE.max"
                  step="5"
                  :value="uiFontScale"
                  @input="onUiFontScaleInput"
                />
                <output for="ui-font-scale">{{ uiFontScale }}%</output>
              </section>
              <section class="settings-field">
                <span class="settings-label">
                  {{ t('menu.language') }}
                </span>
                <InlineChoicePicker id="app-language" :label="t('menu.language')"
                  :value="currentLocale" :options="localeOptions" @change="onLocaleChange" />
              </section>
              <section class="settings-field">
                <label class="settings-label" for="settings-index-start">
                  {{ t('settings.indexDisplayStart') }}
                </label>
                <input
                  type="number"
                  id="settings-index-start" class="settings-input"
                  min="1"
                  step="1"
                  :value="indexDisplayStart"
                  @change="onIndexDisplayStartChange"
                />
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input type="checkbox" :checked="showTooltips"
                    @change="setShowTooltips(($event.target as HTMLInputElement).checked)" />
                  {{ t('settings.showTooltips') }}
                </label>
              </section>
              <h3 class="settings-section-title">{{ t('settings.metersSection') }}</h3>
              <section class="settings-field">
                <span class="settings-label">
                  {{ t('settings.meterMode') }}
                </span>
                <InlineChoicePicker id="settings-meter-display" :label="t('settings.meterMode')"
                  :value="meterMode" :options="meterModeOptions" @change="onMeterModeChange" />
              </section>
              <section class="settings-field">
                <span class="settings-label">
                  {{ t('settings.meterBallistics') }}
                </span>
                <InlineChoicePicker id="settings-meter-ballistics" :label="t('settings.meterBallistics')"
                  :value="meterBallistics" :options="meterBallisticsOptions" @change="onMeterBallisticsChange" />
              </section>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('playlist.title') }}</h3>
              <section class="settings-field track-height-control">
                <label for="regular-playlist-row-height">{{ t('settings.playlistTrackHeight') }}</label>
                <input
                  id="regular-playlist-row-height"
                  type="range"
                  :min="PLAYLIST_ROW_HEIGHTS.regular.min"
                  :max="PLAYLIST_ROW_HEIGHTS.regular.max"
                  step="2"
                  :value="regularPlaylistRowHeight"
                  @input="onPlaylistRowHeightInput('regular', $event)"
                />
                <output for="regular-playlist-row-height">{{ regularPlaylistRowHeight }} px</output>
              </section>
              <section class="settings-field track-height-control">
                <label for="folder-playlist-row-height">{{ t('settings.folderHeaderTrackHeight') }}</label>
                <input
                  id="folder-playlist-row-height"
                  type="range"
                  :min="PLAYLIST_ROW_HEIGHTS.folder.min"
                  :max="PLAYLIST_ROW_HEIGHTS.folder.max"
                  step="2"
                  :value="folderPlaylistRowHeight"
                  @input="onPlaylistRowHeightInput('folder', $event)"
                />
                <output for="folder-playlist-row-height">{{ folderPlaylistRowHeight }} px</output>
              </section>
              <section class="settings-field track-height-control">
                <label for="playlist-waveform-opacity">{{ t('settings.playlistWaveforms') }}</label>
                <input
                  id="playlist-waveform-opacity"
                  type="range"
                  :min="WAVEFORM_OPACITY.min"
                  :max="WAVEFORM_OPACITY.max"
                  step="1"
                  :value="waveformOpacity"
                  @input="onWaveformOpacityInput"
                />
                <output for="playlist-waveform-opacity">{{ waveformOpacity }}%</output>
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="scrollToPlaying"
                    @change="onScrollToPlayingChange"
                  />
                  {{ t('settings.scrollToPlaying') }}
                </label>
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="cycleTrackColors"
                    @change="onCycleTrackColorsChange"
                  />
                  {{ t('settings.cycleTrackColors') }}
                </label>
              </section>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('quickPlays.title') }}</h3>
              <section class="settings-field track-height-control">
                <label for="quickplay-font-scale">{{ t('settings.quickPlayFontSize') }}</label>
                <input
                  id="quickplay-font-scale"
                  type="range"
                  :min="QUICK_PLAY_FONT_SCALE.min"
                  :max="QUICK_PLAY_FONT_SCALE.max"
                  step="5"
                  :value="quickPlayFontScale"
                  @input="onQuickPlayFontScaleInput"
                />
                <output for="quickplay-font-scale">{{ quickPlayFontScale }}%</output>
              </section>
              <section class="settings-field">
                <div class="quickplay-layout-grid">
                  <div class="quickplay-layout-grid__header">{{ t('settings.quickPlayLayout') }}</div>
                  <div class="quickplay-layout-grid__header">{{ t('settings.minimumCardHeight') }}</div>
                  <div class="quickplay-layout-grid__header">{{ t('settings.visibleRows') }}</div>
                  <div class="quickplay-layout-grid__header">{{ t('settings.columns') }}</div>
                  <template v-for="profile in quickPlayGridProfileOptions" :key="profile.id">
                    <div class="quickplay-layout-grid__profile">{{ profile.label }}</div>
                    <input
                      type="number"
                      class="settings-input quickplay-layout-input"
                      :min="QUICK_PLAY_GRID_PROFILES[profile.id].minHeight"
                      :max="QUICK_PLAY_GRID_PROFILES[profile.id].maxHeight"
                      step="2"
                      :value="quickPlayGridLayouts[profile.id].minHeight"
                      :aria-label="`${profile.label}, ${t('settings.minimumCardHeight')}`"
                      @change="onQuickPlayGridLayoutChange(profile.id, 'minHeight', $event)"
                    />
                    <input
                      type="number"
                      class="settings-input quickplay-layout-input"
                      :min="QUICK_PLAY_GRID_LIMITS.rows.min"
                      :max="QUICK_PLAY_GRID_LIMITS.rows.max"
                      step="1"
                      :value="quickPlayGridLayouts[profile.id].rows"
                      :aria-label="`${profile.label}, ${t('settings.visibleRows')}`"
                      @change="onQuickPlayGridLayoutChange(profile.id, 'rows', $event)"
                    />
                    <input
                      type="number"
                      class="settings-input quickplay-layout-input"
                      :min="QUICK_PLAY_GRID_LIMITS.columns.min"
                      :max="QUICK_PLAY_GRID_LIMITS.columns.max"
                      step="1"
                      :value="quickPlayGridLayouts[profile.id].columns"
                      :aria-label="`${profile.label}, ${t('settings.columns')}`"
                      @change="onQuickPlayGridLayoutChange(profile.id, 'columns', $event)"
                    />
                  </template>
                </div>
              </section>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('headerWarnings.settingsTitle') }} <span class="settings-unit">({{ t('settings.secondsUnit') }})</span></h3>
              <section class="settings-field">
                <div class="header-warning-settings">
                  <label v-for="(bounds, field) in HEADER_WARNING_TIMING" :key="field" class="settings-field">
                    <span class="settings-label">{{ t(`headerWarnings.${field}`) }}</span>
                    <input
                      type="number"
                      class="settings-input"
                      required
                      :min="bounds.min"
                      :max="bounds.max"
                      :step="bounds.step"
                      :value="headerWarningTiming[field]"
                      @change="onHeaderWarningTimingChange(field, $event)"
                    />
                  </label>
                </div>
                <p v-if="headerWarningTimingError" class="settings-error" role="alert">{{ headerWarningTimingError }}</p>
              </section>
              <div class="settings-section-title countdown-band-grid countdown-band-heading">
                <h3>{{ t('settings.countdownColors') }}</h3>
                <span class="settings-unit">{{ t('settings.countdownStartsAt') }} (s)</span>
                <span class="settings-unit">{{ t('settings.countdownColor') }}</span>
                <button type="button" class="modal-btn countdown-band-add"
                  :aria-label="t('settings.countdownAddBand')" :title="t('settings.countdownAddBand')"
                  @click="addCountdownBand">
                  <span class="material-symbols-rounded" aria-hidden="true">add</span>
                </button>
              </div>
              <section class="settings-field">
                <div class="countdown-band-editor">
                  <div
                    v-for="(band, index) in countdownColorBands"
                    :key="band.startSeconds"
                    class="countdown-band-grid countdown-band-grid--row"
                  >
                    <span class="countdown-band-range">{{ countdownBandRange(index) }}</span>

                    <input
                      v-if="band.startSeconds > 0"
                      class="settings-input countdown-band-start"
                      type="number"
                      min="1"
                      step="1"
                      :value="band.startSeconds"
                      :aria-label="t('settings.countdownStartsAtFor', { range: countdownBandRange(index) })"
                      @change="onCountdownBandStartChange(band.startSeconds, $event)"
                    />
                    <span v-else class="countdown-band-start countdown-band-fixed">0</span>

                    <InlineColorPicker
                      hide-label opaque
                      :value="band.color"
                      :label="t('settings.countdownColorFor', { range: countdownBandRange(index) })"
                      @change="onCountdownBandColorChange(band.startSeconds, $event)"
                    />

                    <button
                      v-if="band.startSeconds > 0"
                      type="button"
                      class="countdown-band-remove"
                      :aria-label="t('settings.countdownRemoveFor', { range: countdownBandRange(index) })"
                      :title="t('settings.countdownRemoveFor', { range: countdownBandRange(index) })"
                      @click="removeCountdownBand(band.startSeconds)"
                    >
                      <span class="material-symbols-rounded" aria-hidden="true">remove</span>
                    </button>
                    <span v-else></span>
                  </div>
                </div>

                <p v-if="countdownBandError" class="settings-error" role="alert">
                  {{ countdownBandError }}
                </p>
              </section>
            </div>
          </template>
          <!-- ================= Video Output ================= -->
          <template v-else-if="activeTab === 'video'">
            <div v-if="canCheckVideo" class="settings-rows video-check">
              <section class="settings-field test-card-heading video-check-header">
                <h3>{{ t('videoCheck.title') }}</h3>
                <p class="settings-help" role="status">{{ videoCheckMessage }}</p>
                <button type="button" class="modal-btn"
                  :disabled="videoCheckPhase !== 'running' && (!videoCheckReady || videoCheckTransportActive || videoCheckBusy)"
                  @click="videoCheckPhase === 'running' ? cancelVideoCheck() : startVideoCheck()">
                  {{ t(videoCheckPhase === 'running' ? 'videoCheck.cancel' : 'videoCheck.start') }}
                </button>
              </section>
              <ul v-if="videoCheckFindings.length" class="video-check-findings" :aria-label="t('videoCheck.findings')">
                <li v-for="finding in videoCheckFindings" :key="finding.uuid">
                  <strong>{{ finding.label }}{{ finding.label ? ' · ' : '' }}{{ finding.name }}</strong>
                  <span>{{ finding.detail }}</span>
                </li>
              </ul>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.videoOutputDisplay') }}</h3>
              <section class="settings-field">
                <div class="video-output-display-row">
                  <InlineChoicePicker id="settings-output-display" :label="t('settings.videoOutputDisplay')"
                    :value="voStatus?.displayId ?? ''" :options="voDisplayOptions" :disabled="!voStatus"
                    @change="onVideoOutputDisplayChange" />
                  <button type="button" class="modal-btn" @click="onVideoOutputIdentifyDisplays">
                    {{ t('settings.videoOutputIdentifyDisplays') }}
                  </button>
                </div>
              </section>
              <section class="settings-field">
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="voEnabled"
                    @change="onVideoOutputEnableChange"
                  />
                  {{ t('settings.videoOutputEnable') }}
                </label>
              </section>
              <section class="settings-field">
                <div class="video-output-status-row">
                  <span class="settings-label">{{ t('settings.videoOutputStatus') }}</span>
                  <p class="settings-help video-output-status" :class="{ 'video-output-status--warn': !!voWarningText }">
                    {{ voWarningText || voStatusText }}
                  </p>
                </div>
                <p
                  v-if="voStatus?.playbackError"
                  class="settings-help video-output-playback-error"
                  role="alert"
                >
                  <strong>{{ t('common.error') }}:</strong>
                  {{ voStatus.playbackError.message }}
                </p>
                <div class="video-output-standby">
                  <button
                    type="button"
                    class="modal-btn"
                    :disabled="!voStatus?.open || voStatus.restarting"
                    @click="onVideoOutputRestart"
                  >{{ t('settings.videoOutputRestart') }}</button>
                  <button type="button" class="modal-btn" @click="onVideoOutputCopyDiagnostics">
                    {{ t('settings.videoOutputCopyDiagnostics') }}
                  </button>
                </div>
                <p v-if="voDiagnosticsCopied" class="settings-help" role="status">{{ t('settings.videoOutputDiagnosticsCopied') }}</p>
              </section>
              <h3 class="settings-section-title">{{ t('settings.videoFraming.title') }}</h3>
              <section class="settings-field video-framing">
                <div class="video-framing-row">
                  <span class="settings-label">{{ t('settings.videoFraming.preset') }}</span>
                  <InlineChoicePicker id="video-frame-preset" :label="t('settings.videoFraming.preset')"
                    :value="voFramePreset" :options="voFramePresetOptions"
                    :disabled="!voStatus || voFramingPending" @change="selectVideoFramePreset" />
                </div>
                <div v-if="voFramePreset === 'custom'" class="video-framing-dimensions">
                  <label class="settings-field">
                    <span class="settings-label">{{ t('settings.videoFraming.width') }}</span>
                    <input v-model.number="voFraming.width" type="number" class="settings-input"
                      :min="VIDEO_FRAME_LIMITS.minDimension" :max="VIDEO_FRAME_LIMITS.maxDimension" step="1" :disabled="voFramingPending">
                  </label>
                  <label class="settings-field">
                    <span class="settings-label">{{ t('settings.videoFraming.height') }}</span>
                    <input v-model.number="voFraming.height" type="number" class="settings-input"
                      :min="VIDEO_FRAME_LIMITS.minDimension" :max="VIDEO_FRAME_LIMITS.maxDimension" step="1" :disabled="voFramingPending">
                  </label>
                </div>
                <div class="video-framing-row">
                  <span class="settings-label">{{ t('settings.videoFraming.scaling') }}</span>
                  <InlineChoicePicker id="video-frame-scaling" :label="t('settings.videoFraming.scaling')"
                    :value="voFraming.scaling" :options="voFramingScalingOptions"
                    :disabled="!voStatus || voFramingPending" @change="voFraming.scaling = $event" />
                </div>
                <div class="video-framing-row">
                  <label for="video-frame-scale" class="settings-label">{{ t('settings.videoFraming.size') }}</label>
                  <div class="video-framing-size">
                    <input id="video-frame-scale" v-model.number="voFraming.scale" type="number" class="settings-input"
                      :min="VIDEO_FRAME_LIMITS.minScale" :max="VIDEO_FRAME_LIMITS.maxScale" step="1" :disabled="!voStatus || voFramingPending">
                    <span aria-hidden="true">%</span>
                    <button type="button" class="modal-btn" :disabled="!voStatus || voFramingPending || !voFramingDirty"
                      @click="applyVideoFraming">{{ t('settings.videoFraming.apply') }}</button>
                  </div>
                </div>
                <p class="settings-help">{{ t('settings.videoFraming.help') }}</p>
              </section>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.captureSection') }}</h3>
              <section class="settings-field video-standby-field">
                <div class="settings-label">
                  {{ t('settings.videoOutputStandbyImage') }}
                </div>
                <div class="video-output-standby">
                  <span class="video-output-standby-path" :title="voStandbyImage">
                    {{ voStandbyImage || t('settings.videoOutputStandbyNone') }}
                  </span>
                  <button type="button" class="modal-btn" @click="filePicker = 'standby'">
                    {{ t('settings.videoOutputStandbyChoose') }}
                  </button>
                  <button
                    v-if="voStandbyImage"
                    type="button"
                    class="modal-btn"
                    @click="onVideoOutputStandbyClear"
                  >
                    {{ t('settings.videoOutputStandbyClear') }}
                  </button>
                </div>
              </section>
              <section v-if="voStatus" class="settings-field">
                <VideoCaptureControls hide-standby-clear />
              </section>
            </div>
            <div class="settings-rows settings-test-card">
              <section class="settings-field test-card-heading">
                <h3>{{ t('settings.testCardSection') }}</h3>
                <label class="settings-label settings-label--checkbox">
                  <input
                    type="checkbox"
                    :checked="voStatus?.testCard === true"
                    :disabled="!voStatus?.open"
                    @change="onVideoOutputTestCardChange"
                  />
                  {{ t('settings.videoOutputTestCard') }}
                </label>
              </section>
              <section class="settings-field">
                <TestCardControls
                  :config="voTestCardConfig"
                  :disabled="!voStatus"
                  @change="onVideoOutputTestCardConfigChange"
                />
                <p
                  v-if="voStatus?.testCardError"
                  class="settings-help video-output-playback-error"
                  role="alert"
                >
                  <strong>{{ t('common.error') }}:</strong>
                  {{ voStatus.testCardError }}
                </p>
              </section>
            </div>
          </template>

          <!-- ================= Help ================= -->
          <template v-else-if="activeTab === 'help'">
            <button
              v-if="canOpenOperatorManual"
              type="button"
              class="help-link help-link--button"
              @click="openOperatorManual"
            >
              <span class="material-symbols-rounded" aria-hidden="true">menu_book</span>
              <span>{{ t('menu.operatorManual') }}</span>
            </button>
            <a
              href="https://dwcue.com"
              class="help-link"
              @click.prevent="openExternal('https://dwcue.com')"
            >
              <span class="material-symbols-rounded" aria-hidden="true">language</span>
              <span>{{ t('settings.helpDocs') }}</span>
            </a>
            <a
              href="https://github.com/donwellsav/dwcue/issues"
              class="help-link"
              @click.prevent="openExternal('https://github.com/donwellsav/dwcue/issues')"
            >
              <span class="material-symbols-rounded" aria-hidden="true">bug_report</span>
              <span>{{ t('settings.helpIssues') }}</span>
            </a>
          </template>

          <!-- ================= About ================= -->
          <template v-else-if="activeTab === 'about'">
            <AboutContent class="about-content--docked" />
          </template>
        </div>
      </template>
    </TabsContent>
  </TabsRoot>
</template>

<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { useOutputTarget } from '~/composables/useOutputTarget';
import {
  DEFAULT_COUNTDOWN_COLOR_BANDS,
  normalizeCountdownColorBands,
  type CountdownColorBand,
  type ProjectSettings,
} from '~/types/project';
import {
  QUICK_PLAY_GRID_LIMITS,
  QUICK_PLAY_GRID_PROFILES,
  PLAYLIST_ROW_HEIGHTS,
  WAVEFORM_OPACITY,
  UI_FONT_SCALE,
  QUICK_PLAY_FONT_SCALE,
  type QuickPlayGridLayout,
  type QuickPlayGridProfile,
  type PlaylistRowMode,
} from '~/composables/useUiMode';
import { normalizeIndexDisplayStart } from '~/utils/indexDisplay';
import { HEADER_WARNING_TIMING, type HeaderWarningTiming } from '~/utils/headerWarnings';
import AboutContent from './AboutContent.vue';
import ShowBackupsList from './ShowBackupsList.vue';
import ControlConfigModal from './ControlConfigModal.vue';
import TestCardControls from './TestCardControls.vue';
import { createTestCardConfig, type TestCardConfig } from '../../electron/test-card-config.mjs';
import { DEFAULT_VIDEO_FRAMING, VIDEO_FRAME_PRESETS, VIDEO_FRAME_LIMITS, readVideoFraming } from '../../electron/video-output-framing.mjs';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { update } = useAppUpdate();

const { t, currentLocale, setLocale, availableLocales, getDirection } = useLocalization();
const server = useLiveplayServer();

const openExternal = (url: string) => {
  if (import.meta.client && window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
};

const canOpenOperatorManual = import.meta.client && typeof window.electronAPI?.openOperatorManual === 'function';
const openOperatorManual = () => { void window.electronAPI.openOperatorManual(); };

const onLocaleChange = (locale: string) => {
  setLocale(locale);
  if (window.electronAPI?.updateMenuLanguage) {
    void window.electronAPI.updateMenuLanguage(locale);
  }
};

const { currentProject, projectEpoch, indexDisplayStart, saveProject, getAllItemsFlat, formatItemIndex,
  projectHydrationStatus, setMusicContinuity, musicContinuityPending } = useProject();
const accentColors = [
  '#315fcf', '#3c6fe0', '#5a83e8', // DonWells cobalt
  '#007d79', '#009d9a', '#08bdba', // Teals
  '#da1e28', '#a2191f', '#750e13', // Reds
  '#24a148', '#198038', '#0e6027', // Greens
  '#f1c21b', '#d2a106', '#b28600', // Yellows
  '#8a3ffc', '#6929c4', '#491d8b', // Purples
  '#ff7eb6', '#ee5396', '#d02670', // Pinks
];
const selectedAccent = computed(() => currentProject.value?.theme?.accentColor?.toLowerCase() || accentColors[0]);
function setAccentColor(color: string) {
  const project = currentProject.value;
  if (!project || projectHydrationStatus.value !== 'ready' || selectedAccent.value === color) return;
  project.theme.accentColor = color;
  void saveProject();
}
const {
  regularPlaylistRowHeight,
  folderPlaylistRowHeight,
  waveformOpacity,
  uiFontScale,
  quickPlayFontScale,
  quickPlayGridLayouts,
  headerWarningTiming,
  showTooltips,
  setRegularPlaylistRowHeight,
  setFolderPlaylistRowHeight,
  setWaveformOpacity,
  setUiFontScale,
  setQuickPlayFontScale,
  setQuickPlayGridLayout,
  setHeaderWarningTiming,
  setShowTooltips,
} = useUiMode();

const headerWarningTimingError = ref('');
function onHeaderWarningTimingChange(field: keyof HeaderWarningTiming, event: Event) {
  const input = event.target as HTMLInputElement;
  const next = { ...headerWarningTiming.value, [field]: input.valueAsNumber };
  if (!input.validity.valid || next.lowerThreshold >= next.upperThreshold) {
    input.value = String(headerWarningTiming.value[field]);
    headerWarningTimingError.value = t('headerWarnings.invalidTiming');
    return;
  }
  headerWarningTimingError.value = '';
  setHeaderWarningTiming(next);
}

// One layout for the QuickPlays panel and one for the detached window; Edit
// Mode and Show Mode share them.
const quickPlayGridProfileOptions = computed<Array<{ id: QuickPlayGridProfile; label: string }>>(() => [
  { id: 'attachedRegular', label: t('quickPlays.title') },
  { id: 'detachedRegular', label: t('controls.toggleDetachedQuickPlays') },
]);

const devices = computed(() => server.devices ?? []);
const audioDeviceOptions = computed(() => {
  const options = new Map(devices.value.map(d => [d.display_name, {
    value: d.display_name,
    label: d.is_default ? `${d.display_name} (${t('common.default')})` : d.display_name,
  }]));
  return [{ value: '', label: t('settings.noneSelected') }, ...options.values()];
});
const localeOptions = computed(() => availableLocales.value.map(locale => ({ value: locale.code, label: locale.name })));
const transitionModeOptions = computed(() => [
  { value: 'crossfade', label: t('settings.transitionModeCrossfade') },
  { value: 'start-next', label: t('settings.transitionModeStartNext') },
] as const);
const meterModeOptions = computed(() => [
  { value: 'LUFS', label: t('settings.meterModeLufs') },
  { value: 'dBFS', label: t('settings.meterModeDbfs') },
  { value: 'dBTP', label: t('settings.meterModeDbtp') },
  { value: 'RMS', label: t('settings.meterModeRms') },
] as const);
const meterBallisticsOptions = computed(() => [
  { value: 'digital-ppm', label: t('settings.meterBallisticsDigitalPpm') },
  { value: 'ppm-i', label: t('settings.meterBallisticsPpmI') },
  { value: 'ppm-ii', label: t('settings.meterBallisticsPpmII') },
  { value: 'vu', label: t('settings.meterBallisticsVu') },
  { value: 'instant', label: t('settings.meterBallisticsInstant') },
] as const);
const outputTargetOptions = computed(() => [
  { value: 'ebu-r128', label: t('settings.outputTargetEbuR128') },
  { value: 'streaming', label: t('settings.outputTargetStreaming') },
  { value: 'radio', label: t('settings.outputTargetRadio') },
  { value: 'netflix', label: t('settings.outputTargetNetflix') },
  { value: 'live', label: t('settings.outputTargetLive') },
]);

// Tabs mirror the Properties panel's tab styling. Grouping:
//  - audio    : device routing + loudness target
//  - playback : transitions, auto-cue, stop-all fade, limiter and warnings
//  - ui       : metering + list behaviour
// help/about are informational tabs, not project settings — nothing in
// them patches the document.
type SettingsTabId = 'audio' | 'playback' | 'ui' | 'video' | 'shortcuts' | 'midi' | 'help' | 'about';
interface SettingsTab {
  id: SettingsTabId;
  label: string;
  icon?: string;
  symbol?: 'video-output';
}

const activeTab = useState<SettingsTabId>('projectSettingsTab', () => 'audio');

// Pre-show check opens its report in the lower panel, in place of Settings,
// and runs itself there. Level Check walks each cue's loudest window on the
// PROGRAM output (the external mixer must see it; preview routes elsewhere);
// its bar lives in MainWorkspace and this only switches the mode.
const { open: openShowCheck } = usePreShowCheck();
const {
  active: levelCheckActive, items: levelCheckItems, start: startLevelCheck, exit: exitLevelCheck,
} = useLevelCheck();
const levelCheckCount = computed(() => levelCheckItems.value.length);
const toggleLevelCheck = () => {
  if (levelCheckActive.value) void exitLevelCheck();
  else startLevelCheck();
};
const canCheckVideo = import.meta.client && !!window.electronAPI?.videoOutput?.checkFrame;
const {
  busy: videoCheckBusy, phase: videoCheckPhase, ready: videoCheckReady,
  transportActive: videoCheckTransportActive, findings: videoCheckFindings, message: videoCheckMessage,
  start: startVideoCheck, cancel: cancelVideoCheck,
} = useVideoPreflight();
const tabs = computed<SettingsTab[]>(() => [
  { id: 'audio', icon: 'graphic_eq', label: t('settings.tabAudioRouting') },
  { id: 'playback', icon: 'play_circle', label: t('settings.tabPlaybackBehaviour') },
  { id: 'ui', icon: 'desktop_windows', label: t('settings.tabUserInterface') },
  { id: 'video', symbol: 'video-output', label: t('settings.tabVideoOutput') },
  { id: 'shortcuts', icon: 'keyboard', label: t('controls.shortcutBtn') },
  { id: 'midi', icon: 'piano', label: t('controls.tabMidi') },
  // menu_book, NOT help: a circled "?" reads as a tooltip affordance and
  // the operator has repeatedly rejected those.
  { id: 'help', icon: 'menu_book', label: t('settings.tabHelp') },
  { id: 'about', icon: 'info', label: t('settings.tabAbout') },
]);

// The settings live on the project document; we read them from there and
// patch via the server endpoint.
const audioDeviceId = computed(() => {
  const selected = (currentProject.value as any)?.settings?.defaultOutputDevice || '';
  return devices.value.find(device => device.id === selected)?.display_name ?? selected;
});
const previewDeviceId        = computed(() => (currentProject.value as any)?.settings?.previewDevice || '');
const ltcDeviceId            = computed(() => (currentProject.value as any)?.settings?.ltcDevice || '');
const outputTarget           = computed(() => (currentProject.value as any)?.settings?.outputTarget || 'ebu-r128');
const cycleTrackColors = computed(() =>
  (currentProject.value as any)?.settings?.cycleTrackColors !== false);
const disableLimiter           = computed(() => !!(currentProject.value as any)?.settings?.disableLimiter);
const disableSilenceWarning    = computed(() => !!(currentProject.value as any)?.settings?.disableSilenceWarning);
const defaultTransitionMode    = computed(() => (currentProject.value as any)?.settings?.defaultTransitionMode || 'crossfade');
// Defaults ON (undefined → true) so legacy projects and new projects both
// arm the next item as "Up Next" for cues without an end behaviour. (#28)
const autoCueNextWithoutEndBehavior = computed(() => (currentProject.value as any)?.settings?.autoCueNextWithoutEndBehavior !== false);
const configuredMusicBackup = computed(() => currentProject.value?.settings?.backupMusicGroup ?? '');
const musicBackupOptions = computed(() => {
  const groups = getAllItemsFlat().filter(item => item.type === 'group');
  const selected = configuredMusicBackup.value;
  return [
    { value: '', label: t('musicContinuity.none') },
    ...groups.map(group => ({ value: group.uuid, label: `${formatItemIndex(group.index)} · ${group.displayName}` })),
    ...(selected && !groups.some(group => group.uuid === selected)
      ? [{ value: selected, label: t('musicContinuity.missing'), disabled: true }] : []),
  ];
});
const changeMusicBackup = (value: string) => {
  const backupMusicGroup = value || null;
  return setMusicContinuity(undefined, backupMusicGroup ? { backupMusicGroup } : { backupMusicGroup, keepMusicGoing: false },
    status => { settingsError.value = t(`musicContinuity.${status}`); });
};
// Project-wide Stop All fade, stored in ms (default 1000). Shown in seconds.
const stopAllFadeSeconds = computed(() => {
  const ms = (currentProject.value as any)?.settings?.stopAllFadeMs;
  return ((typeof ms === 'number' ? ms : 1000) / 1000);
});
// UI scrolls to keep the currently-playing item centred (default OFF).
const scrollToPlaying = computed(() => !!(currentProject.value as any)?.settings?.uiScrollToPlaying);
const { meterMode: currentMeterMode } = useOutputTarget();
const meterMode              = computed(() => (currentProject.value as any)?.settings?.meterMode || currentMeterMode.value);
const meterBallistics        = computed(() => (currentProject.value as any)?.settings?.meterBallistics || 'digital-ppm');
const countdownColorBands = computed(() => normalizeCountdownColorBands(
  (currentProject.value as any)?.settings?.countdownColorBands,
));
const countdownBandError = ref('');
const settingsError = ref('');

function describeSettingsError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('common.error');
}

async function refreshDevices() {
  settingsError.value = '';
  try {
    await server.fetchDevices();
  } catch (error) {
    settingsError.value = describeSettingsError(error);
  }
}

// Make sure devices are loaded when the modal opens.
watch(() => props.open, async (v) => {
  if (v) await refreshDevices();
});
// Video Output tab. Open/closed state is session-only; display assignment is
// machine-level state in the Electron main process (<userData>/video-output.json)
// and deliberately NOT in the project document. All mutations return fresh
// status; the onStatus push keeps this panel live while it is open.
// ---------------------------------------------------------------------------
const voStatus = ref<VideoOutputStatus | null>(null);
const voFraming = ref({ ...DEFAULT_VIDEO_FRAMING });
const voFramePreset = ref('1080p');
const voFramingPending = ref(false);
const voFramingDirty = computed(() => {
  const saved = voStatus.value?.framing ?? DEFAULT_VIDEO_FRAMING;
  const draft = voFraming.value;
  return saved.width !== draft.width || saved.height !== draft.height || saved.scale !== draft.scale || saved.scaling !== draft.scaling;
});
const voDiagnosticsCopied = ref(false);
const voTestCardConfig = ref<TestCardConfig>(createTestCardConfig());

const voEnabled  = computed(() => voStatus.value?.enabled === true);
const voDisplays = computed(() => voStatus.value?.displays ?? []);
const voDisplayOptions = computed(() => [
  { value: '', label: t('settings.videoOutputNoDisplay') },
  ...voDisplays.value.map(d => ({
    value: d.id,
    label: `${d.index} — ${d.label} — ${d.width}×${d.height}${d.primary ? ` (${t('common.default')})` : ''}`,
  })),
]);
const voFramePresetOptions = computed(() => [
  ...VIDEO_FRAME_PRESETS.map(preset => ({
    value: preset.id, label: `${t(`settings.videoFraming.${preset.id}`)} · ${preset.width}×${preset.height}`,
  })),
  { value: 'custom', label: t('settings.videoFraming.custom') },
]);
const voFramingScalingOptions = computed(() => [
  { value: 'fit', label: t('settings.videoFraming.fit') },
  { value: 'limit', label: t('settings.videoFraming.limit') },
] as const);

const voTargetDisplay = computed(() =>
  voDisplays.value.find((d) => d.id === voStatus.value?.targetId) ?? null);

const voStatusText = computed(() => {
  const s = voStatus.value;
  if (!s || !s.enabled) return t('settings.videoOutputStatusOff');
  const d = voTargetDisplay.value;
  if (!s.open) return t('settings.videoOutputStatusOff');
  if (!d) return t('settings.videoOutputStatusPreview');
  return t('settings.videoOutputStatusOn', { label: d.label, size: `${d.width}×${d.height}` });
});

const voWarningText = computed(() => {
  const w = voStatus.value?.warning;
  if (w === 'single-display') return t('settings.videoOutputWarnSingleDisplay');
  if (w === 'display-missing') return t('settings.videoOutputWarnMissing');
  if (w === 'display-shared-with-control') return t('settings.videoOutputWarnShared');
  if (w === 'display-not-covered') return t('settings.videoOutputWarnNotCovered');
  return '';
});

let voTestCardConfigWriting = false;
let voHasLocalTestCardConfigIntent = false;
let voPendingTestCardConfig: TestCardConfig | null = null;

function receiveVideoOutputStatus(status: VideoOutputStatus, forceConfig = false): void {
  const saved = voStatus.value?.framing ?? DEFAULT_VIDEO_FRAMING;
  const incoming = status.framing ?? DEFAULT_VIDEO_FRAMING;
  if (forceConfig || (!voFramingDirty.value && JSON.stringify(saved) !== JSON.stringify(incoming))) {
    voFraming.value = { ...incoming };
    voFramePreset.value = VIDEO_FRAME_PRESETS.find(preset => preset.width === voFraming.value.width
      && preset.height === voFraming.value.height)?.id ?? 'custom';
  }
  voStatus.value = status;
  if (voTestCardConfigWriting) return;
  if (forceConfig || !voHasLocalTestCardConfigIntent) {
    voTestCardConfig.value = createTestCardConfig(status.testCardConfig);
    if (forceConfig) voHasLocalTestCardConfigIntent = false;
  }
}

function selectVideoFramePreset(value: string): void {
  voFramePreset.value = value;
  const preset = VIDEO_FRAME_PRESETS.find(entry => entry.id === value);
  if (preset) {
    voFraming.value.width = preset.width;
    voFraming.value.height = preset.height;
  }
}

async function applyVideoFraming(): Promise<void> {
  const api = window.electronAPI?.videoOutput;
  if (!api?.setFraming || voFramingPending.value) return;
  const framing = readVideoFraming(voFraming.value);
  if (!framing) {
    settingsError.value = t('settings.videoFraming.invalid');
    return;
  }
  voFramingPending.value = true;
  settingsError.value = '';
  try { receiveVideoOutputStatus(await api.setFraming(framing), true); }
  catch (error) { settingsError.value = describeSettingsError(error); }
  finally { voFramingPending.value = false; }
}

async function onVideoOutputEnableChange(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  settingsError.value = '';
  try {
    receiveVideoOutputStatus(enabled ? await api.open() : await api.close());
  } catch (error) {
    settingsError.value = describeSettingsError(error);
  }
}

async function onVideoOutputDisplayChange(value: string) {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  settingsError.value = '';
  try {
    receiveVideoOutputStatus(await api.setDisplay(value || null));
  } catch (error) {
    settingsError.value = describeSettingsError(error);
  }
}

async function onVideoOutputRestart() {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  settingsError.value = '';
  try { receiveVideoOutputStatus(await api.restart()); }
  catch (error) { settingsError.value = describeSettingsError(error); }
}

async function onVideoOutputCopyDiagnostics() {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  voDiagnosticsCopied.value = false;
  settingsError.value = '';
  try {
    await navigator.clipboard.writeText(JSON.stringify(await api.diagnostics(), null, 2));
    voDiagnosticsCopied.value = true;
  } catch (error) { settingsError.value = describeSettingsError(error); }
}

async function onVideoOutputIdentifyDisplays() {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  settingsError.value = '';
  try {
    await api.identifyDisplays();
  } catch (error) {
    settingsError.value = describeSettingsError(error);
  }
}

async function onVideoOutputTestCardChange(event: Event) {
  const show = (event.target as HTMLInputElement).checked;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  settingsError.value = '';
  try {
    await api.setTestCard(show);
  } catch (error) {
    settingsError.value = describeSettingsError(error);
  }
}

function onVideoOutputTestCardConfigChange(config: TestCardConfig): void {
  const normalized = createTestCardConfig(config);
  voTestCardConfig.value = normalized;
  voHasLocalTestCardConfigIntent = true;
  voPendingTestCardConfig = normalized;
  void drainVideoOutputTestCardConfig();
}

async function drainVideoOutputTestCardConfig(): Promise<void> {
  if (voTestCardConfigWriting) return;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;

  voTestCardConfigWriting = true;
  while (voPendingTestCardConfig) {
    const config = voPendingTestCardConfig;
    voPendingTestCardConfig = null;
    settingsError.value = '';
    try {
      const status = await api.setTestCardConfig(config);
      voStatus.value = status;
      if (!voPendingTestCardConfig) {
        voTestCardConfig.value = createTestCardConfig(status.testCardConfig);
      }
    } catch (error) {
      settingsError.value = describeSettingsError(error);
    }
  }
  voTestCardConfigWriting = false;
}

// Standby image — the one video-output setting that IS project-level (it
// belongs to the show, not the machine). The picked file is copied into the
// project media folder and stored relative, so the show file stays portable.
const voStandbyImage = computed(() =>
  (currentProject.value as any)?.settings?.videoStandbyImage || '');
const filePicker = useState<'cue' | 'standby' | 'replace-media' | null>('workspaceFilePicker', () => null);
const closeStandbyImagePicker = () => {
  if (filePicker.value === 'standby') filePicker.value = null;
};
watch([() => props.open, projectEpoch, activeTab], closeStandbyImagePicker, { flush: 'sync' });
onScopeDispose(closeStandbyImagePicker);

async function onVideoOutputStandbyPicked(path: string) {
  closeStandbyImagePicker();
  const project = currentProject.value;
  const epoch = projectEpoch.value;
  if (!project || server.cueStartsBlocked) return;
  settingsError.value = '';
  try {
    const dest = await server.copyToMedia(path);
    if (currentProject.value !== project || projectEpoch.value !== epoch || server.cueStartsBlocked) return;
    const folder = project.folderPath;
    const relative = folder && dest.startsWith(folder)
      ? dest.slice(folder.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : dest;
    await applyPatch({ videoStandbyImage: relative });
  } catch (error) {
    console.warn('[ProjectSettings] standby image copy failed:', error);
    settingsError.value = describeSettingsError(error);
  }
}

async function onVideoOutputStandbyClear() {
  await applyPatch({ videoStandbyImage: null });
}

let voOffStatus: (() => void) | null = null;

watch(() => props.open, async (v) => {
  if (!v) return;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  try { receiveVideoOutputStatus(await api.status(), true); } catch { /* main not ready yet */ }
});

onMounted(() => {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  api.status().then((status) => receiveVideoOutputStatus(status, true)).catch(() => {});
  voOffStatus = api.onStatus((status) => receiveVideoOutputStatus(status));
});

onBeforeUnmount(() => {
  voOffStatus?.();
  voOffStatus = null;
});

// Refresh devices on first mount too.
onMounted(async () => {
  await refreshDevices();
});

type PatchResult = 'saved' | 'unsaved' | 'failed';
type PreviousSetting = { exists: boolean; value: unknown };

let settingsPatchQueue = Promise.resolve();

function applyPatch(request: Record<string, any> | ((settings: ProjectSettings) => Record<string, any> | null)): Promise<PatchResult> {
  const project = currentProject.value as any;
  const queued = settingsPatchQueue.then(async (): Promise<PatchResult> => {
    if (!project || currentProject.value !== project) return 'saved';

    const settings = (project.settings ?? {});
    const patch = typeof request === 'function' ? request(settings) : request;
    if (!patch) return 'saved';
    const outputEdit = ['defaultOutputDevice', 'previewDevice', 'ltcDevice'].some(key => key in patch);
    const previousSettings = new Map<string, PreviousSetting>();
    settingsError.value = '';
    for (const key of Object.keys(patch)) {
      previousSettings.set(key, {
        exists: Object.prototype.hasOwnProperty.call(settings, key),
        value: settings[key],
      });
    }
    if (!outputEdit) project.settings = { ...settings, ...patch };

    try {
      await server.patchSettings(patch);
    } catch (error) {
      console.warn('[ProjectSettings] patch failed:', error);
      if (currentProject.value !== project) return 'saved';

      if (!outputEdit) {
        const restored = { ...(project.settings ?? {}) };
        for (const [key, previous] of previousSettings) {
          if (previous.exists) restored[key] = previous.value;
          else delete restored[key];
        }
        project.settings = restored;
      }
      settingsError.value = describeSettingsError(error);
      return 'failed';
    }

    // The server accepted this project's live change. Never save whichever
    // project happens to become current while that acknowledgement is pending.
    if (currentProject.value !== project) return 'saved';
    if (outputEdit) {
      const applied = { ...(project.settings ?? {}) };
      for (const [key, previous] of previousSettings) {
        if (applied[key] === previous.value) applied[key] = patch[key];
      }
      project.settings = applied;
    }
    try {
      const saved = await saveProject();
      if (currentProject.value !== project) return 'saved';
      if (saved) return 'saved';
    } catch (error) {
      if (currentProject.value !== project) return 'saved';
      settingsError.value = describeSettingsError(error);
      return 'unsaved';
    }

    settingsError.value = server.reconnecting
      ? `${t('project.unsavedChanges')} — ${t('connectionLost.attempting')}`
      : t('project.unsavedChanges');
    return 'unsaved';
  });

  // Serialize edits so a rejected optimistic value can never become the
  // rollback baseline for another in-flight change to the same setting.
  settingsPatchQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function countdownBandRange(index: number): string {
  const bands = countdownColorBands.value;
  const band = bands[index];
  if (!band) return '';
  if (bands.length === 1) return t('settings.countdownAllTimes');
  if (index === 0) {
    return t('settings.countdownRangeAndAbove', { start: band.startSeconds });
  }
  return t('settings.countdownRangeBetween', {
    start: band.startSeconds,
    end: bands[index - 1]!.startSeconds - 1,
  });
}

let countdownMutationVersion = 0;

async function persistCountdownBands(edit: (bands: CountdownColorBand[]) => boolean) {
  const mutationVersion = ++countdownMutationVersion;
  countdownBandError.value = '';
  const result = await applyPatch(settings => {
    const bands = normalizeCountdownColorBands(settings.countdownColorBands);
    return edit(bands) ? { countdownColorBands: normalizeCountdownColorBands(bands) } : null;
  });
  if (mutationVersion !== countdownMutationVersion || result === 'saved') return;

  // applyPatch restores a rejected live change. A disk-save failure leaves the
  // accepted server value in place and marks it visibly unsaved.
  countdownBandError.value = t('settings.countdownSaveFailed');
}

function onCountdownBandStartChange(startSeconds: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const seconds = Number(input.value);
  void persistCountdownBands(bands => {
    const band = bands.find(band => band.startSeconds === startSeconds);
    if (!band || startSeconds === seconds) return false;
    if (!Number.isInteger(seconds) || seconds < 1 || bands.some(other => other.startSeconds === seconds)) {
      countdownBandError.value = t('settings.countdownThresholdInvalid');
      input.value = String(startSeconds);
      return false;
    }
    band.startSeconds = seconds;
    return true;
  });
}

function onCountdownBandColorChange(startSeconds: number, color: string) {
  void persistCountdownBands(bands => {
    const band = bands.find(band => band.startSeconds === startSeconds);
    if (!band || band.color === color) return false;
    band.color = color;
    return true;
  });
}

function addCountdownBand() {
  void persistCountdownBands(bands => {
    const highestStart = bands[0]?.startSeconds ?? 0;
    bands.push({ startSeconds: highestStart + 5, color: DEFAULT_COUNTDOWN_COLOR_BANDS[0]!.color });
    return true;
  });
}

function removeCountdownBand(startSeconds: number) {
  if (startSeconds === 0) return;
  void persistCountdownBands(bands => {
    const index = bands.findIndex(band => band.startSeconds === startSeconds);
    if (index === -1) return false;
    bands.splice(index, 1);
    return true;
  });
}

async function onAudioDeviceChange(v: string) {
  await applyPatch({ defaultOutputDevice: v || null });
}
async function onPreviewDeviceChange(v: string) {
  await applyPatch({ previewDevice: v || null });
}
async function onLtcDeviceChange(v: string) {
  await applyPatch({ ltcDevice: v || null });
}
async function onOutputTargetChange(v: string) {
  await applyPatch({ outputTarget: v });
}
async function onMeterModeChange(value: string) {
  await applyPatch({ meterMode: value });
}
async function onMeterBallisticsChange(value: string) {
  await applyPatch({ meterBallistics: value });
}
async function onCycleTrackColorsChange(e: Event) {
  await applyPatch({ cycleTrackColors: (e.target as HTMLInputElement).checked });
}
async function onDisableLimiterChange(e: Event) {
  await applyPatch({ disableLimiter: (e.target as HTMLInputElement).checked });
}
async function onDisableSilenceWarningChange(e: Event) {
  await applyPatch({ disableSilenceWarning: (e.target as HTMLInputElement).checked });
}
async function onDefaultTransitionModeChange(value: string) {
  await applyPatch({ defaultTransitionMode: value });
}
async function onIndexDisplayStartChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const value = normalizeIndexDisplayStart(input.value);
  input.value = String(value);
  await applyPatch({ indexDisplayStart: value });
}
async function onAutoCueNextChange(e: Event) {
  await applyPatch({ autoCueNextWithoutEndBehavior: (e.target as HTMLInputElement).checked });
}
async function onStopAllFadeChange(e: Event) {
  const seconds = parseFloat((e.target as HTMLInputElement).value);
  const ms = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 1000;
  await applyPatch({ stopAllFadeMs: ms });
}
async function onScrollToPlayingChange(e: Event) {
  await applyPatch({ uiScrollToPlaying: (e.target as HTMLInputElement).checked });
}

function onPlaylistRowHeightInput(mode: PlaylistRowMode, e: Event) {
  const value = (e.target as HTMLInputElement).value;
  if (mode === 'folder') setFolderPlaylistRowHeight(value);
  else setRegularPlaylistRowHeight(value);
}

function onWaveformOpacityInput(e: Event) {
  setWaveformOpacity((e.target as HTMLInputElement).value);
}
function onUiFontScaleInput(e: Event) {
  setUiFontScale((e.target as HTMLInputElement).value);
}

function onQuickPlayFontScaleInput(e: Event) {
  setQuickPlayFontScale((e.target as HTMLInputElement).value);
}

function onQuickPlayGridLayoutChange(
  profile: QuickPlayGridProfile,
  field: keyof QuickPlayGridLayout,
  e: Event,
) {
  const input = e.target as HTMLInputElement;
  const current = quickPlayGridLayouts.value[profile][field];
  if (!input.value.trim()) {
    input.value = String(current);
    return;
  }
  const value = Number(input.value);
  setQuickPlayGridLayout(profile, {
    [field]: Number.isFinite(value) ? value : current,
  });
  input.value = String(quickPlayGridLayouts.value[profile][field]);
}

function close() {
  emit('close');
}
</script>

<style scoped>
.project-settings-panel {
  flex: 1;
  min-height: 0;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
  display: flex;
  flex-direction: column;
  color: var(--color-text-primary);
  container-type: inline-size;
}

/* Title, tabs and Close sit on top, where every other panel has them. */
.settings-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) var(--panel-control-height);
  gap: var(--spacing-md);
  padding-block: 0;
  border-top: 0;
  border-bottom: 1px solid var(--color-border);
}

.close-x {
  display: grid;
  place-items: center;
  width: var(--panel-control-height);
  height: var(--panel-control-height);
  padding: 0;
  background: none;
  border: none;
  border-radius: var(--control-radius);
  color: var(--color-text-secondary);
  font-size: 18px;
  cursor: pointer;
}
.close-x:hover {
  background: var(--color-surface-hover);
}

.settings-tabs {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  align-self: stretch;
  min-width: 0;
  max-width: var(--settings-width);
  border-inline-start: 1px solid var(--color-border);
}
.tab-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  gap: var(--spacing-xs);
  padding: 0 var(--spacing-sm);
  background: none;
  border: none;
  border-inline-end: 1px solid var(--color-border);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--color-text-primary);
  font-size: var(--type-metadata-size);
  font-weight: 600;
  line-height: 1.15;
}
.settings-tab-label {
  min-width: 0;
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.tab-btn .material-symbols-rounded,
.tab-btn :deep(.cue-symbol) {
  font-size: 18px;
  flex-shrink: 0;
  color: inherit;
}
.tab-btn:hover {
  background-color: var(--color-surface-hover);
}
.tab-btn[data-state='active'] {
  color: var(--color-accent-text);
  background: var(--color-accent-soft);
  border-bottom-color: var(--color-accent);
}
.tab-btn:focus-visible { outline-offset: -3px; }

@container (max-width: 1180px) {
  .tab-btn { padding-inline: var(--spacing-xs); }
  .tab-btn .material-symbols-rounded,
  .tab-btn :deep(.cue-symbol) { display: none; }
}

.settings-tabpanel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.settings-tabpanel[hidden] { display: none; }

.settings-content {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  width: min(100%, var(--settings-width));
  align-content: start;
  flex: 1;
  min-height: 0;
  padding: var(--spacing-xs) var(--workspace-gutter);
  gap: var(--spacing-sm);
  overflow-y: auto;
}

.settings-content--playback {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  row-gap: 0;
}

.settings-content--playback > .settings-rows {
  display: grid;
  grid-row: span 4;
  grid-template-rows: subgrid;
}

/* Show backups sits under both columns: its list needs the width, and a fifth
   row in one column would break the row alignment between the two above. */
.settings-content--playback > .settings-rows--wide {
  display: block;
  grid-column: 1 / -1;
  grid-row: auto;
  margin-top: var(--spacing-sm);
}

.settings-content--playback .settings-rows--wide > .settings-field {
  padding-block: var(--spacing-xs);
}

.settings-test-card { grid-column: span 2; }

.video-check { grid-column: 1 / -1; }

/* The two checks share one row across the tab: button, then what it does. */
.show-checks {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.settings-rows.show-checks > .settings-field.show-checks__row {
  flex-direction: row;
  justify-content: flex-start;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 5px var(--spacing-sm);
}
.settings-rows.show-checks > .show-checks__row + .show-checks__row {
  border-top: 0;
  border-inline-start: 1px solid var(--color-border);
}
.show-checks__row > .modal-btn { flex: none; font-weight: 600; }
.show-checks__row > .modal-btn:disabled { color: var(--color-text-disabled); cursor: default; }
/* A check that is running: the button is filled, not just tinted. */
.modal-btn.modal-btn--on,
.modal-btn.modal-btn--on:hover {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
}
.settings-rows > .video-check-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--spacing-sm);
}
.video-check-findings {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--type-metadata-size);
}
.video-check-findings li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--spacing-sm);
  padding: 4px var(--spacing-sm);
  overflow-wrap: anywhere;
}
.video-check-findings li + li { border-top: 1px solid var(--color-border); }
.video-check-findings li > span { color: var(--color-danger); }

.settings-content--help {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
}

.settings-unit {
  color: var(--color-text-secondary);
  font-weight: 400;
}

.settings-content--about { display: block; }

.settings-content > .settings-error {
  grid-column: 1 / -1;
}

.settings-content > .settings-field,
.settings-rows {
  min-width: 0;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
}

.settings-content > .settings-field {
  padding: 5px var(--spacing-sm);
}

.settings-section-title,
.settings-rows > .test-card-heading,
.settings-content--audio > .settings-field > .settings-label {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: 4px;
  align-content: center;
  min-height: var(--settings-row-height);
  margin: 0;
  padding: 3px var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.35;
}

.settings-rows > .settings-section-title:not(:first-child) { border-top: 1px solid var(--color-border); }

.settings-rows > .test-card-heading {
  align-items: center;
  justify-content: space-between;
  flex-direction: row;
  padding-block: 1px;
}

.test-card-heading h3,
.countdown-band-heading h3,
.test-card-heading .settings-label {
  font-size: inherit;
  line-height: inherit;
}

.settings-rows > .settings-field:not(.test-card-heading) {
  justify-content: center;
  min-height: var(--settings-row-height);
  padding: 1px var(--spacing-sm);
  line-height: 1.25;
}

.settings-content--playback .settings-rows > .settings-field {
  min-height: 50px;
  padding-block: 3px;
}

.settings-rows > .settings-field:has(> :is(.quickplay-layout-grid, .header-warning-settings, .countdown-band-editor)) {
  padding-block: 0;
}

.settings-rows > .settings-field + .settings-field {
  border-top: 1px solid var(--color-border);
}

.settings-rows > .test-card-heading + .settings-field { border-top: 0; }

.settings-rows > .settings-field:has(> :is(.settings-input, .inline-choice-picker)) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 45%);
  column-gap: var(--spacing-sm);
  align-items: center;
}

.settings-content--audio > .settings-field {
  display: grid;
  grid-row: span 2;
  grid-template-rows: subgrid;
  gap: 0;
  padding: 0;
}

.audio-routing-choice {
  display: grid;
  align-content: start;
  gap: var(--spacing-xs);
  min-width: 0;
  padding: var(--spacing-xs) var(--spacing-sm);
}

.settings-field > .settings-help { grid-column: 1 / -1; }

.settings-content--playback .settings-field > :is(.settings-input, .inline-choice-picker:not([open])) {
  max-width: 180px;
  justify-self: end;
}

.settings-field > .inline-choice-picker { width: 100%; }
.settings-field:has(> .inline-choice-picker[open]) { align-items: start; }
.settings-field:has(> .inline-choice-picker) > .settings-label { min-height: var(--settings-control-height); }

.settings-content--ui .track-height-control {
  grid-template-columns: minmax(0, 1fr) minmax(40px, 0.8fr) 44px;
  line-height: 1.25;
}

.settings-content--ui .settings-field > .settings-input { text-align: center; }

.accent-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  padding-block: var(--spacing-xs);
}

.accent-swatch {
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  cursor: pointer;

  &[aria-pressed="true"],
  &:focus-visible {
    outline: 2px solid var(--color-text-primary);
    outline-offset: 1px;
  }
}

.settings-content .video-standby-field {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: var(--spacing-sm);
}

@container (max-width: 900px) {
  .settings-content:not(.settings-content--help) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container (max-width: 740px) {
  .settings-content:not(.settings-content--help) { grid-template-columns: minmax(0, 1fr); }
  .settings-content--playback { gap: var(--spacing-sm); }
  .settings-content--playback > .settings-rows { display: block; grid-row: auto; }
  .settings-test-card { grid-column: auto; }
}

.settings-field {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--spacing-xs);
}
.header-warning-settings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--spacing-xs);
}
.header-warning-settings .settings-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: var(--settings-row-height);
  gap: 2px;
}
.header-warning-settings .settings-label {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.25;
}
.header-warning-settings .settings-input {
  width: 44px;
  padding-inline: 3px;
}
.settings-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text-primary);
  font-weight: 600;
}
.settings-input {
  width: 100%;
  min-width: 0;
  min-height: var(--settings-control-height);
  padding: 2px var(--spacing-sm);
  background: var(--color-background);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font-size: 13px;
}
.settings-input:focus {
  outline: none;
  border-color: var(--color-accent);
}
.settings-help {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.video-output-status-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px var(--spacing-sm);
}
.video-output-status {
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}
.video-output-status--warn {
  color: var(--color-warning, #f1c21b);
  font-weight: 600;
}
.video-output-playback-error {
  padding: 8px 10px;
  color: var(--color-danger);
  background: var(--color-surface);
  border: 1px solid var(--color-danger);
  border-radius: var(--control-radius);
}
.video-output-display-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px;
  align-items: start;
}
.video-output-display-row .modal-btn,
.video-output-standby .modal-btn { padding-inline: 6px; }
.video-framing-row,
.video-framing-dimensions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 62%);
  align-items: center;
  gap: var(--spacing-xs);
}
.video-framing-row:has(> #video-frame-preset[open]) { grid-template-columns: minmax(0, 1fr); }
.video-framing-row:has(> .inline-choice-picker[open]) { align-items: start; }
.video-framing-row > .settings-label { min-height: var(--settings-control-height); }
.video-framing-row:has(> #video-frame-preset[open]) > .settings-label { min-height: 0; }
.video-framing-dimensions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.video-framing-size { display: flex; align-items: center; gap: var(--spacing-xs); }
.video-framing-size .modal-btn { flex-shrink: 0; }
.video-output-standby {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.video-output-standby > .modal-btn { min-width: 0; }
.video-output-standby-path {
  flex: 1 1 52px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
}

.track-height-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(58px, 1fr) 44px;
  gap: 6px;
  align-items: center;
  color: var(--color-text-primary);
  font-size: 13px;
}
.settings-field.track-height-control { align-items: center; }
.track-height-control input[type="range"] {
  width: 100%;
  min-width: 0;
  height: var(--settings-control-height);
  margin: 0;
  padding: 0;
  accent-color: var(--color-accent);
}
.track-height-control output {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.quickplay-layout-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(3, 46px);
  grid-auto-rows: minmax(var(--settings-row-height), auto);
  gap: 0 4px;
  align-items: center;
  line-height: 1.25;
}
.quickplay-layout-grid__header {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}
.quickplay-layout-grid__profile {
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 500;
}
.quickplay-layout-input {
  height: var(--settings-control-height);
  min-width: 0;
  padding: 2px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.settings-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-danger);
}

.countdown-band-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 42px 100px 24px;
  gap: 4px;
  align-items: center;
}
.settings-rows > .countdown-band-heading {
  display: grid;
  align-items: center;
  padding-block: 1px;
}
.countdown-band-heading .settings-unit {
  text-align: center;
  font-size: 11px;
}
.countdown-band-grid--row {
  min-height: var(--settings-row-height);
  padding: 1px 0;
  align-items: start;
  border-bottom: 1px solid var(--color-border);
}
.countdown-band-grid--row:last-child { border-color: transparent; }
.countdown-band-range,
.countdown-band-fixed {
  display: flex;
  align-items: center;
  min-height: var(--settings-control-height);
}
.countdown-band-range {
  font-size: 12px;
  line-height: 1.25;
  color: var(--color-text-primary);
}
.countdown-band-start {
  min-height: var(--settings-control-height);
  padding-inline: 4px;
  text-align: center;
}
.countdown-band-fixed {
  justify-content: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.countdown-band-remove {
  display: grid;
  place-items: center;
  width: 24px;
  height: var(--settings-control-height);
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  cursor: pointer;
}
.countdown-band-remove:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.countdown-band-remove:focus-visible,
.countdown-band-start:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.countdown-band-heading .countdown-band-add {
  grid-column: 4;
  display: grid;
  place-items: center;
  width: 24px;
  min-height: var(--settings-control-height);
  padding: 0;
}
.countdown-band-add .material-symbols-rounded {
  font-size: 18px;
}
.settings-label--checkbox {
  flex-direction: row;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text-primary);
  cursor: pointer;
}
.settings-label--checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  margin: 0;
  cursor: pointer;
  accent-color: var(--color-accent);
}

.help-link {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-height: var(--settings-row-height);
  padding: var(--spacing-xs) var(--spacing-sm);
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  color: var(--color-text-primary);
  text-decoration: none;
  font-size: 13px;
  text-align: left;
  max-width: 100%;
  box-sizing: border-box;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.help-link:hover {
  background-color: var(--color-surface-hover);
  border-color: var(--color-accent);
  color: var(--color-accent-text);
}

.help-link .material-symbols-rounded {
  font-size: 20px;
}

.update-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-warning);
}

.modal-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  color: var(--color-text-primary);
  min-height: var(--settings-control-height);
  padding: 3px var(--spacing-sm);
  cursor: pointer;
  font-size: 12px;
}
.modal-btn:hover {
  background: var(--color-surface-hover);
}
</style>
