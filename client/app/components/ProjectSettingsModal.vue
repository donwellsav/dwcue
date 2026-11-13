<template>
  <section v-if="open" class="project-settings-panel" :aria-label="t('settings.title')">
        <header class="workspace-panel-header settings-header">
          <h2 class="workspace-panel-header__title">{{ t('settings.title') }}</h2>
          <nav class="settings-tabs" :aria-label="t('settings.title')">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              :class="['tab-btn', { active: activeTab === tab.id }]"
              :aria-pressed="activeTab === tab.id"
              @click="activeTab = tab.id"
            >
              <CueSymbol v-if="tab.symbol" :name="tab.symbol" />
              <span v-else class="material-symbols-rounded" aria-hidden="true">{{ tab.icon }}</span>
              <span>{{ tab.label }}</span>
              <span v-if="tab.id === 'about' && update.version" class="update-dot" :aria-label="t('update.updateAvailable')"></span>
            </button>
          </nav>
          <button type="button" class="close-x" :aria-label="t('actions.close')" @click="close">
            <span class="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </header>

        <ControlConfigModal v-if="activeTab === 'shortcuts' || activeTab === 'midi'"
          :mode="activeTab === 'midi' ? 'midi' : 'keyboard'" />
        <div v-else :key="activeTab" :class="['settings-content', `settings-content--${activeTab}`]">
          <p v-if="settingsError" class="settings-error" role="alert">
            {{ settingsError }}
          </p>
          <!-- ================= Audio Routing ================= -->
          <template v-if="activeTab === 'audio'">
            <!-- Audio device (default for cue playback) -->
            <section class="settings-field">
              <label class="settings-label" for="settings-audio-device">
                {{ t('settings.audioDevice') }}
              </label>
              <select
                id="settings-audio-device"
                class="settings-select"
                :value="audioDeviceId"
                @change="onAudioDeviceChange"
              >
                <option :value="''">{{ t('settings.noneSelected') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.display_name">
                  {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
                </option>
              </select>
              <p class="settings-help">{{ t('settings.audioDeviceHelp') }}</p>
            </section>

            <!-- Preview stores the stable hardware name; opened-device ids are session-scoped. -->
            <section class="settings-field">
              <label class="settings-label" for="settings-preview-device">
                {{ t('settings.previewDevice') }}
              </label>
              <select
                id="settings-preview-device"
                class="settings-select"
                :value="previewDeviceId"
                @change="onPreviewDeviceChange"
              >
                <option :value="''">{{ t('settings.noneSelected') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.display_name">
                  {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
                </option>
              </select>
              <p class="settings-help">{{ t('settings.previewDeviceHelp') }}</p>
            </section>

            <!-- LTC device (timecode output) -->
            <section class="settings-field">
              <label class="settings-label" for="settings-ltc-device">
                {{ t('settings.ltcDevice') }}
              </label>
              <select
                id="settings-ltc-device"
                class="settings-select"
                :value="ltcDeviceId"
                @change="onLtcDeviceChange"
              >
                <option :value="''">{{ t('settings.noneSelected') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.display_name">
                  {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
                </option>
              </select>
              <p class="settings-help">{{ t('settings.ltcDeviceHelp') }}</p>
            </section>

            <!-- Output Target (loudness platform standard) -->
            <section class="settings-field">
              <label class="settings-label" for="settings-output-target">
                {{ t('settings.outputTarget') }}
              </label>
              <select
                id="settings-output-target" class="settings-select"
                :value="outputTarget"
                @change="onOutputTargetChange"
              >
                <option value="ebu-r128">{{ t('settings.outputTargetEbuR128') }}</option>
                <option value="streaming">{{ t('settings.outputTargetStreaming') }}</option>
                <option value="radio">{{ t('settings.outputTargetRadio') }}</option>
                <option value="netflix">{{ t('settings.outputTargetNetflix') }}</option>
                <option value="live">{{ t('settings.outputTargetLive') }}</option>
              </select>
              <p class="settings-help">{{ t('settings.outputTargetHelp') }}</p>
            </section>
          </template>

          <!-- ================= Playback Behaviour ================= -->
          <template v-else-if="activeTab === 'playback'">
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.cueingSection') }}</h3>
              <section class="settings-field">
                <label class="settings-label" for="settings-transition">
                  {{ t('settings.transitionMode') }}
                </label>
                <select
                  id="settings-transition" class="settings-select"
                  :value="defaultTransitionMode"
                  @change="onDefaultTransitionModeChange"
                >
                  <option value="crossfade">{{ t('settings.transitionModeCrossfade') }}</option>
                  <option value="start-next">{{ t('settings.transitionModeStartNext') }}</option>
                </select>
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
              <section class="settings-field playback-switches">
                <div class="settings-field">
                  <label class="settings-label settings-label--checkbox">
                    <input
                      type="checkbox"
                      :checked="disableLimiter"
                      @change="onDisableLimiterChange"
                    />
                    {{ t('settings.disableLimiter') }}
                  </label>
                  <p class="settings-help">{{ t('settings.disableLimiterHelp') }}</p>
                </div>
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
          </template>

          <!-- ================= User Interface ================= -->
          <template v-else-if="activeTab === 'ui'">
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('settings.appearanceSection') }}</h3>
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
                <label class="settings-label" for="app-language">
                  {{ t('menu.language') }}
                </label>
                <select
                  id="app-language"
                  class="settings-select"
                  :value="currentLocale"
                  @change="onLocaleChange"
                >
                  <option
                    v-for="locale in availableLocales"
                    :key="locale.code"
                    :value="locale.code"
                  >
                    {{ locale.name }}
                  </option>
                </select>
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
              <h3 class="settings-section-title">{{ t('settings.metersSection') }}</h3>
              <section class="settings-field">
                <label class="settings-label" for="settings-meter-display">
                  {{ t('settings.meterMode') }}
                </label>
                <select
                  id="settings-meter-display" class="settings-select"
                  :value="meterMode"
                  @change="onMeterModeChange"
                >
                  <option value="LUFS">{{ t('settings.meterModeLufs') }}</option>
                  <option value="dBFS">{{ t('settings.meterModeDbfs') }}</option>
                  <option value="dBTP">{{ t('settings.meterModeDbtp') }}</option>
                  <option value="RMS">{{ t('settings.meterModeRms') }}</option>
                </select>
              </section>
              <section class="settings-field">
                <label class="settings-label" for="settings-meter-ballistics">
                  {{ t('settings.meterBallistics') }}
                </label>
                <select
                  id="settings-meter-ballistics" class="settings-select"
                  :value="meterBallistics"
                  @change="onMeterBallisticsChange"
                >
                  <option value="digital-ppm">{{ t('settings.meterBallisticsDigitalPpm') }}</option>
                  <option value="ppm-i">{{ t('settings.meterBallisticsPpmI') }}</option>
                  <option value="ppm-ii">{{ t('settings.meterBallisticsPpmII') }}</option>
                  <option value="vu">{{ t('settings.meterBallisticsVu') }}</option>
                  <option value="instant">{{ t('settings.meterBallisticsInstant') }}</option>
                </select>
              </section>
            </div>
            <div class="settings-rows">
              <h3 class="settings-section-title">{{ t('playlist.title') }}</h3>
              <section class="settings-field track-height-control">
                <label for="regular-playlist-row-height">{{ t('settings.regularModeTrackHeight') }}</label>
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
                <label for="show-playlist-row-height">{{ t('settings.showModeTrackHeight') }}</label>
                <input
                  id="show-playlist-row-height"
                  type="range"
                  :min="PLAYLIST_ROW_HEIGHTS.show.min"
                  :max="PLAYLIST_ROW_HEIGHTS.show.max"
                  step="2"
                  :value="showPlaylistRowHeight"
                  @input="onPlaylistRowHeightInput('show', $event)"
                />
                <output for="show-playlist-row-height">{{ showPlaylistRowHeight }} px</output>
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
              <h3 class="settings-section-title">{{ t('oneShots.title') }}</h3>
              <section class="settings-field track-height-control">
                <label for="one-shot-font-scale">{{ t('settings.oneShotFontSize') }}</label>
                <input
                  id="one-shot-font-scale"
                  type="range"
                  :min="ONE_SHOT_FONT_SCALE.min"
                  :max="ONE_SHOT_FONT_SCALE.max"
                  step="5"
                  :value="oneShotFontScale"
                  @input="onOneShotFontScaleInput"
                />
                <output for="one-shot-font-scale">{{ oneShotFontScale }}%</output>
              </section>
              <section class="settings-field">
                <div class="cart-layout-grid">
                  <div class="cart-layout-grid__header">{{ t('settings.cartLayout') }}</div>
                  <div class="cart-layout-grid__header">{{ t('settings.minimumCardHeight') }}</div>
                  <div class="cart-layout-grid__header">{{ t('settings.visibleRows') }}</div>
                  <div class="cart-layout-grid__header">{{ t('settings.columns') }}</div>
                  <template v-for="profile in cartGridProfileOptions" :key="profile.id">
                    <div class="cart-layout-grid__profile">{{ profile.label }}</div>
                    <input
                      type="number"
                      class="settings-input cart-layout-input"
                      :min="CART_GRID_PROFILES[profile.id].minHeight"
                      :max="CART_GRID_PROFILES[profile.id].maxHeight"
                      step="2"
                      :value="cartGridLayouts[profile.id].minHeight"
                      :aria-label="`${profile.label}, ${t('settings.minimumCardHeight')}`"
                      @change="onCartGridLayoutChange(profile.id, 'minHeight', $event)"
                    />
                    <input
                      type="number"
                      class="settings-input cart-layout-input"
                      :min="CART_GRID_LIMITS.rows.min"
                      :max="CART_GRID_LIMITS.rows.max"
                      step="1"
                      :value="cartGridLayouts[profile.id].rows"
                      :aria-label="`${profile.label}, ${t('settings.visibleRows')}`"
                      @change="onCartGridLayoutChange(profile.id, 'rows', $event)"
                    />
                    <input
                      type="number"
                      class="settings-input cart-layout-input"
                      :min="CART_GRID_LIMITS.columns.min"
                      :max="CART_GRID_LIMITS.columns.max"
                      step="1"
                      :value="cartGridLayouts[profile.id].columns"
                      :aria-label="`${profile.label}, ${t('settings.columns')}`"
                      @change="onCartGridLayoutChange(profile.id, 'columns', $event)"
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
                      @change="onCountdownBandStartChange(index, $event)"
                    />
                    <span v-else class="countdown-band-start countdown-band-fixed">0</span>

                    <input
                      class="countdown-band-color"
                      type="color"
                      :value="band.color"
                      :title="band.color"
                      :aria-label="t('settings.countdownColorFor', { range: countdownBandRange(index) })"
                      @change="onCountdownBandColorChange(index, $event)"
                    />

                    <button
                      v-if="band.startSeconds > 0"
                      type="button"
                      class="countdown-band-remove"
                      :aria-label="t('settings.countdownRemoveFor', { range: countdownBandRange(index) })"
                      :title="t('settings.countdownRemoveFor', { range: countdownBandRange(index) })"
                      @click="removeCountdownBand(index)"
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
            <div class="settings-rows">
              <h3 class="settings-section-title">
                <label for="settings-output-display">{{ t('settings.videoOutputDisplay') }}</label>
              </h3>
              <section class="settings-field">
                <div class="video-output-display-row">
                  <select
                    id="settings-output-display"
                    class="settings-select"
                    :value="voStatus?.displayId ?? ''"
                    @change="onVideoOutputDisplayChange"
                  >
                    <option :value="''">{{ t('settings.videoOutputNoDisplay') }}</option>
                    <option v-for="d in voDisplays" :key="d.id" :value="d.id">
                      {{ d.index }} — {{ d.label }} — {{ d.width }}×{{ d.height }}{{ d.primary ? ' (' + t('common.default') + ')' : '' }}
                    </option>
                  </select>
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
                  <button type="button" class="modal-btn" @click="voStandbyPickerOpen = true">
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
              <template v-if="voStatus">
                <section class="settings-field video-capture">
                  <label for="capture-display" class="settings-label">{{ t('standbyCapture.display') }}</label>
                  <select id="capture-display" class="settings-select" :value="voStatus.captureDisplayId ?? ''"
                    :disabled="captureSettingsPending || standbyCapturePending"
                    @change="onCaptureSettingsChange($event, 'display')">
                    <option value="">{{ t('standbyCapture.chooseDisplay') }}</option>
                    <option v-if="voStatus.captureDisplayId && !voDisplays.some(d => d.id === voStatus?.captureDisplayId)"
                      :value="voStatus.captureDisplayId" disabled>{{ t('standbyCapture.missingDisplay') }}</option>
                    <option v-for="d in voDisplays" :key="d.id" :value="d.id">
                      {{ d.index }} · {{ d.label }} ({{ d.width }} × {{ d.height }})
                    </option>
                  </select>
                </section>
                <section class="settings-field video-capture">
                  <label for="capture-destination" class="settings-label">{{ t('standbyCapture.destination') }}</label>
                  <select id="capture-destination" class="settings-select" :value="voStatus.captureTarget ?? 'session'"
                    :disabled="captureSettingsPending || standbyCapturePending"
                    @change="onCaptureSettingsChange($event, 'target')">
                    <option value="session">{{ t('standbyCapture.session') }}</option>
                    <option value="cue">{{ t('standbyCapture.cue') }}</option>
                  </select>
                </section>
              </template>
              <section v-if="voStatus" class="settings-field">
                <div class="video-output-standby">
                  <button type="button" class="modal-btn" :disabled="standbyCapturePending || !voStatus.open"
                    @click="captureStandby('output', voStatus.captureTarget)">{{ t('standbyCapture.outputButton') }}</button>
                  <button type="button" class="modal-btn"
                    :disabled="standbyCapturePending || !voDisplays.some(d => d.id === voStatus?.captureDisplayId)"
                    @click="captureStandby('display', voStatus.captureTarget)">{{ t('standbyCapture.displayButton') }}</button>
                  <button type="button" class="modal-btn" :disabled="standbyCapturePending"
                    @click="captureStandby('clear', voStatus.captureTarget)">{{ t('standbyCapture.clearButton') }}</button>
                </div>
                <p class="settings-help">{{ t('standbyCapture.help') }}</p>
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

    <ServerFilePickerModal
      :open="voStandbyPickerOpen"
      mode="file"
      filter=".png,.jpg,.jpeg,.webp,.gif,.svg"
      :fallback-start-path="voStandbyPickerStart"
      location-context="standby-image"
      @pick="onVideoOutputStandbyPicked"
      @close="voStandbyPickerOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { useOutputTarget } from '~/composables/useOutputTarget';
import {
  DEFAULT_COUNTDOWN_COLOR_BANDS,
  normalizeCountdownColorBands,
  type CountdownColorBand,
} from '~/types/project';
import {
  CART_GRID_LIMITS,
  CART_GRID_PROFILES,
  PLAYLIST_ROW_HEIGHTS,
  WAVEFORM_OPACITY,
  UI_FONT_SCALE,
  ONE_SHOT_FONT_SCALE,
  type CartGridLayout,
  type CartGridProfile,
  type PlaylistRowMode,
} from '~/composables/useUiMode';
import { normalizeIndexDisplayStart } from '~/utils/indexDisplay';
import { HEADER_WARNING_TIMING, type HeaderWarningTiming } from '~/utils/headerWarnings';
import AboutContent from './AboutContent.vue';
import ControlConfigModal from './ControlConfigModal.vue';
import TestCardControls from './TestCardControls.vue';
import { createTestCardConfig, type TestCardConfig } from '../../electron/test-card-config.mjs';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { update } = useAppUpdate();

const { t, currentLocale, setLocale, availableLocales } = useLocalization();
const server = useLiveplayServer();

const openExternal = (url: string) => {
  if (import.meta.client && window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
};

const canOpenOperatorManual = import.meta.client && typeof window.electronAPI?.openOperatorManual === 'function';
const openOperatorManual = () => { void window.electronAPI.openOperatorManual(); };

const onLocaleChange = (event: Event) => {
  const locale = (event.target as HTMLSelectElement).value;
  setLocale(locale);
  if (window.electronAPI?.updateMenuLanguage) {
    void window.electronAPI.updateMenuLanguage(locale);
  }
};

const { currentProject, indexDisplayStart, saveProject } = useProject();
const {
  regularPlaylistRowHeight,
  showPlaylistRowHeight,
  folderPlaylistRowHeight,
  waveformOpacity,
  uiFontScale,
  oneShotFontScale,
  cartGridLayouts,
  headerWarningTiming,
  setRegularPlaylistRowHeight,
  setShowPlaylistRowHeight,
  setFolderPlaylistRowHeight,
  setWaveformOpacity,
  setUiFontScale,
  setOneShotFontScale,
  setCartGridLayout,
  setHeaderWarningTiming,
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

const cartGridProfileOptions = computed<Array<{ id: CartGridProfile; label: string }>>(() => [
  { id: 'attachedRegular', label: t('settings.cartLayoutAttachedRegular') },
  { id: 'attachedShow', label: t('settings.cartLayoutAttachedShow') },
  { id: 'detachedRegular', label: t('settings.cartLayoutDetachedRegular') },
  { id: 'detachedShow', label: t('settings.cartLayoutDetachedShow') },
]);

const devices = computed(() => server.devices ?? []);

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
const { captureStandby, standbyCapturePending } = useVideoStandbyCapture();
const captureSettingsPending = ref(false);
const voDiagnosticsCopied = ref(false);
const voTestCardConfig = ref<TestCardConfig>(createTestCardConfig());

const voEnabled  = computed(() => voStatus.value?.enabled === true);
const voDisplays = computed(() => voStatus.value?.displays ?? []);

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
  return '';
});

let voTestCardConfigWriting = false;
let voHasLocalTestCardConfigIntent = false;
let voPendingTestCardConfig: TestCardConfig | null = null;

function receiveVideoOutputStatus(status: VideoOutputStatus, forceConfig = false): void {
  voStatus.value = status;
  if (voTestCardConfigWriting) return;
  if (forceConfig || !voHasLocalTestCardConfigIntent) {
    voTestCardConfig.value = createTestCardConfig(status.testCardConfig);
    if (forceConfig) voHasLocalTestCardConfigIntent = false;
  }
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

async function onVideoOutputDisplayChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  settingsError.value = '';
  try {
    receiveVideoOutputStatus(await api.setDisplay(value || null));
  } catch (error) {
    settingsError.value = describeSettingsError(error);
  }
}

async function onCaptureSettingsChange(event: Event, field: 'display' | 'target') {
  const input = event.target as HTMLSelectElement;
  const api = window.electronAPI?.videoOutput;
  const status = voStatus.value;
  if (!api?.setCaptureSettings || !status) return;
  const display = field === 'display' ? input.value || null : status.captureDisplayId;
  const target = field === 'target' ? (input.value === 'cue' ? 'cue' : 'session') : status.captureTarget;
  captureSettingsPending.value = true;
  settingsError.value = '';
  try {
    receiveVideoOutputStatus(await api.setCaptureSettings(display, target));
  } catch (error) {
    input.value = field === 'display' ? status.captureDisplayId ?? '' : status.captureTarget;
    settingsError.value = describeSettingsError(error);
  } finally {
    captureSettingsPending.value = false;
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
const voStandbyPickerOpen = ref(false);
const voStandbyPickerStart = computed(() =>
  (currentProject.value as any)?.folderPath || '');

async function onVideoOutputStandbyPicked(path: string) {
  voStandbyPickerOpen.value = false;
  settingsError.value = '';
  try {
    const dest = await server.copyToMedia(path);
    const folder: string = (currentProject.value as any)?.folderPath || '';
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

function applyPatch(patch: Record<string, any>): Promise<PatchResult> {
  const project = currentProject.value as any;
  const queued = settingsPatchQueue.then(async (): Promise<PatchResult> => {
    if (!project || currentProject.value !== project) return 'saved';

    const settings = (project.settings ?? {});
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

async function persistCountdownBands(bands: CountdownColorBand[]) {
  const mutationVersion = ++countdownMutationVersion;
  countdownBandError.value = '';
  const next = normalizeCountdownColorBands(bands);
  const result = await applyPatch({ countdownColorBands: next });
  if (mutationVersion !== countdownMutationVersion || result === 'saved') return;

  // applyPatch restores a rejected live change. A disk-save failure leaves the
  // accepted server value in place and marks it visibly unsaved.
  countdownBandError.value = t('settings.countdownSaveFailed');
}

function onCountdownBandStartChange(index: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const bands = countdownColorBands.value.map(band => ({ ...band }));
  const seconds = Number(input.value);
  const duplicate = bands.some((band, i) => i !== index && band.startSeconds === seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || duplicate) {
    countdownBandError.value = t('settings.countdownThresholdInvalid');
    input.value = String(bands[index]?.startSeconds ?? 1);
    return;
  }

  bands[index] = { ...bands[index]!, startSeconds: seconds };
  void persistCountdownBands(bands);
}

function onCountdownBandColorChange(index: number, e: Event) {
  const bands = countdownColorBands.value.map(band => ({ ...band }));
  bands[index] = {
    ...bands[index]!,
    color: (e.target as HTMLInputElement).value.toUpperCase(),
  };
  void persistCountdownBands(bands);
}

function addCountdownBand() {
  const bands = countdownColorBands.value.map(band => ({ ...band }));
  const highestStart = bands[0]?.startSeconds ?? 0;
  bands.push({
    startSeconds: highestStart + 5,
    color: DEFAULT_COUNTDOWN_COLOR_BANDS[0]!.color,
  });
  void persistCountdownBands(bands);
}

function removeCountdownBand(index: number) {
  const bands = countdownColorBands.value.map(band => ({ ...band }));
  if (!bands[index] || bands[index]!.startSeconds === 0) return;
  bands.splice(index, 1);
  void persistCountdownBands(bands);
}

async function onAudioDeviceChange(e: Event) {
  const input = e.target as HTMLSelectElement;
  const v = input.value;
  input.value = audioDeviceId.value;
  await applyPatch({ defaultOutputDevice: v || null });
}
async function onPreviewDeviceChange(e: Event) {
  const input = e.target as HTMLSelectElement;
  const v = input.value;
  input.value = previewDeviceId.value;
  await applyPatch({ previewDevice: v || null });
}
async function onLtcDeviceChange(e: Event) {
  const input = e.target as HTMLSelectElement;
  const v = input.value;
  input.value = ltcDeviceId.value;
  await applyPatch({ ltcDevice: v || null });
}
async function onOutputTargetChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  await applyPatch({ outputTarget: v });
}
async function onMeterModeChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  await applyPatch({ meterMode: v });
}
async function onMeterBallisticsChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  await applyPatch({ meterBallistics: v });
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
async function onDefaultTransitionModeChange(e: Event) {
  await applyPatch({ defaultTransitionMode: (e.target as HTMLSelectElement).value });
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
  if (mode === 'show') setShowPlaylistRowHeight(value);
  else if (mode === 'folder') setFolderPlaylistRowHeight(value);
  else setRegularPlaylistRowHeight(value);
}

function onWaveformOpacityInput(e: Event) {
  setWaveformOpacity((e.target as HTMLInputElement).value);
}
function onUiFontScaleInput(e: Event) {
  setUiFontScale((e.target as HTMLInputElement).value);
}

function onOneShotFontScaleInput(e: Event) {
  setOneShotFontScale((e.target as HTMLInputElement).value);
}

function onCartGridLayoutChange(
  profile: CartGridProfile,
  field: keyof CartGridLayout,
  e: Event,
) {
  const input = e.target as HTMLInputElement;
  const current = cartGridLayouts.value[profile][field];
  if (!input.value.trim()) {
    input.value = String(current);
    return;
  }
  const value = Number(input.value);
  setCartGridLayout(profile, {
    [field]: Number.isFinite(value) ? value : current,
  });
  input.value = String(cartGridLayouts.value[profile][field]);
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

.settings-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) var(--panel-control-height);
  gap: var(--spacing-md);
  padding-block: 0;
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
  grid-auto-columns: minmax(112px, 1fr);
  align-self: stretch;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  gap: 2px;
}
.tab-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  padding: 0 var(--spacing-sm);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.tab-btn .material-symbols-rounded,
.tab-btn :deep(.cue-symbol) {
  font-size: 18px;
  color: inherit;
}
.tab-btn:hover {
  background-color: var(--color-surface-hover);
}
.tab-btn.active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border-bottom-color: var(--color-accent);
}
.tab-btn:focus-visible { outline-offset: -3px; }

@container (max-width: 1180px) {
  .tab-btn { padding-inline: var(--spacing-xs); }
  .tab-btn .material-symbols-rounded,
  .tab-btn :deep(.cue-symbol) { display: none; }
}

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
  grid-row: span 3;
  grid-template-rows: subgrid;
}

.settings-rows > .playback-switches {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  align-content: center;
}

.settings-test-card { grid-column: span 2; }

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

.settings-rows > .settings-field:has(> :is(.cart-layout-grid, .header-warning-settings, .countdown-band-editor)) {
  padding-block: 0;
}

.settings-rows > .settings-field + .settings-field {
  border-top: 1px solid var(--color-border);
}

.settings-rows > .test-card-heading + .settings-field { border-top: 0; }

.settings-rows > .settings-field:has(> .settings-select, > .settings-input) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 45%);
  column-gap: var(--spacing-sm);
  align-items: center;
}

.settings-content--audio > .settings-field {
  display: grid;
  grid-row: span 3;
  grid-template-rows: subgrid;
  gap: 0;
  padding: 0;
}

.settings-content--audio > .settings-field > .settings-select {
  width: calc(100% - 2 * var(--spacing-sm));
  margin: var(--spacing-xs) var(--spacing-sm) 0;
}

.settings-content--audio > .settings-field > .settings-help {
  grid-column: auto;
  padding: var(--spacing-xs) var(--spacing-sm);
}

.settings-field > .settings-help { grid-column: 1 / -1; }

.settings-content--playback .settings-field > :is(.settings-input, .settings-select) {
  max-width: 180px;
  justify-self: end;
}

.settings-content--ui .track-height-control {
  grid-template-columns: minmax(0, 1fr) minmax(40px, 0.8fr) 44px;
  line-height: 1.25;
}

.settings-content--ui .settings-field > .settings-input { text-align: center; }

.settings-rows > .settings-field.video-capture {
  grid-template-columns: minmax(0, 1fr) minmax(0, 56%);
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
.settings-select,
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
.settings-select:focus,
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
  align-items: stretch;
}
.video-output-display-row .modal-btn,
.video-output-standby .modal-btn { padding-inline: 6px; }
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
.cart-layout-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(3, 46px);
  grid-auto-rows: minmax(var(--settings-row-height), auto);
  gap: 0 4px;
  align-items: center;
  line-height: 1.25;
}
.cart-layout-grid__header {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}
.cart-layout-grid__profile {
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 500;
}
.cart-layout-input {
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
  grid-template-columns: minmax(0, 1fr) 42px 29px 24px;
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
  border-bottom: 1px solid var(--color-border);
}
.countdown-band-grid--row:last-child { border-color: transparent; }
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
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.countdown-band-color {
  width: 28px;
  height: var(--settings-control-height);
  padding: 2px;
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  cursor: pointer;
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
.countdown-band-start:focus-visible,
.countdown-band-color:focus-visible {
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
  color: var(--color-accent);
}

.help-link .material-symbols-rounded {
  font-size: 20px;
}

.update-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--state-up-next);
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
