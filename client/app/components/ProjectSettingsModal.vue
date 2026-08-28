<template>
  <!-- Note: NOT inside <Teleport> — Vue scoped styles don't reach teleported
       nodes, which would leave the modal unstyled in production builds. -->
  <div v-if="open" class="project-settings-backdrop" @click.self="close">
    <div class="project-settings-modal">
        <header class="modal-header">
          <h2>{{ t('settings.title') }}</h2>
          <button
            type="button"
            class="close-x"
            :aria-label="t('actions.close')"
            :title="t('actions.close')"
            @click="close"
          >✕</button>
        </header>

        <!-- Tab Navigation (styled to match the Properties panel) -->
        <div class="settings-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            :class="['tab-btn', { active: activeTab === tab.id }]"
            @click="activeTab = tab.id"
          >
            <span class="material-symbols-rounded" aria-hidden="true">{{ tab.icon }}</span>
            <span>{{ tab.label }}</span>
          </button>
        </div>

        <div class="modal-body">
          <!-- ================= Audio Routing ================= -->
          <template v-if="activeTab === 'audio'">
            <!-- Audio device (default for cue playback) -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">speaker</span>
                {{ t('settings.audioDevice') }}
              </label>
              <select
                class="settings-select"
                :value="audioDeviceId"
                @change="onAudioDeviceChange"
              >
                <option :value="''">{{ t('settings.noneSelected') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.id">
                  {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
                </option>
              </select>
              <p class="settings-help">{{ t('settings.audioDeviceHelp') }}</p>
            </section>

            <!-- Preview device (used by headphones button) -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">headphones</span>
                {{ t('settings.previewDevice') }}
              </label>
              <select
                class="settings-select"
                :value="previewDeviceId"
                @change="onPreviewDeviceChange"
              >
                <option :value="''">{{ t('settings.noneSelected') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.id">
                  {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
                </option>
              </select>
              <p class="settings-help">{{ t('settings.previewDeviceHelp') }}</p>
            </section>

            <!-- LTC device (timecode output) -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">schedule</span>
                {{ t('settings.ltcDevice') }}
              </label>
              <select
                class="settings-select"
                :value="ltcDeviceId"
                @change="onLtcDeviceChange"
              >
                <option :value="''">{{ t('settings.noneSelected') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.id">
                  {{ d.display_name }}{{ d.is_default ? ' (' + t('common.default') + ')' : '' }}
                </option>
              </select>
              <p class="settings-help">{{ t('settings.ltcDeviceHelp') }}</p>
            </section>

            <!-- Output Target (loudness platform standard) -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">tune</span>
                {{ t('settings.outputTarget') }}
              </label>
              <select
                class="settings-select"
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
            <!-- Default transition mode -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">swap_horiz</span>
                {{ t('settings.transitionMode') }}
              </label>
              <select
                class="settings-select"
                :value="defaultTransitionMode"
                @change="onDefaultTransitionModeChange"
              >
                <option value="crossfade">{{ t('settings.transitionModeCrossfade') }}</option>
                <option value="start-next">{{ t('settings.transitionModeStartNext') }}</option>
              </select>
              <p class="settings-help">{{ t('settings.transitionModeHelp') }}</p>
            </section>

            <!-- Auto-cue next item without end behaviour (#28) -->
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

            <!-- Project-wide Stop All fade-out time -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">stop_circle</span>
                {{ t('settings.stopAllFade') }}
              </label>
              <input
                type="number"
                class="settings-input"
                min="0"
                step="0.1"
                :value="stopAllFadeSeconds"
                @change="onStopAllFadeChange"
              />
              <p class="settings-help">{{ t('settings.stopAllFadeHelp') }}</p>
            </section>

            <!-- Import processing options are independently controlled. -->
            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="autoTrimSilenceOnImport"
                  @change="onAutoTrimSilenceOnImportChange"
                />
                {{ t('settings.autoTrimSilenceOnImport') }}
              </label>
              <p class="settings-help">{{ t('settings.autoTrimSilenceOnImportHelp') }}</p>
            </section>

            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="autoMatchLoudnessOnImport"
                  @change="onAutoMatchLoudnessOnImportChange"
                />
                {{ t('settings.autoMatchLoudnessOnImport') }}
              </label>
              <p class="settings-help">{{ t('settings.autoMatchLoudnessOnImportHelp') }}</p>
            </section>

            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="autoReduceTruePeaksOnImport"
                  @change="onAutoReduceTruePeaksOnImportChange"
                />
                {{ t('settings.autoReduceTruePeaksOnImport') }}
              </label>
              <p class="settings-help">{{ t('settings.autoReduceTruePeaksOnImportHelp') }}</p>
            </section>

            <!-- Disable true-peak limiter -->
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

            <!-- Disable silence warning -->
            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="disableSilenceWarning"
                  @change="onDisableSilenceWarningChange"
                />
                {{ t('settings.disableSilenceWarning') }}
              </label>
              <p class="settings-help">{{ t('settings.disableSilenceWarningHelp') }}</p>
            </section>
          </template>

          <!-- ================= User Interface ================= -->
          <template v-else-if="activeTab === 'ui'">

            <!-- Playlist numbering -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">format_list_numbered</span>
                {{ t('settings.indexDisplayStart') }}
              </label>
              <input
                type="number"
                class="settings-input"
                min="0"
                step="1"
                :value="indexDisplayStart"
                @change="onIndexDisplayStartChange"
              />
              <p class="settings-help">{{ t('settings.indexDisplayStartHelp') }}</p>
            </section>

            <!-- Per-device playlist density -->
            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">density_medium</span>
                {{ t('settings.playlistTrackHeight') }}
              </div>
              <div class="track-height-control">
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
              </div>
              <div class="track-height-control">
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
              </div>
              <div class="track-height-control">
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
              </div>
              <p class="settings-help">{{ t('settings.playlistTrackHeightHelp') }}</p>
            </section>

            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">waterfall_chart</span>
                {{ t('settings.playlistWaveforms') }}
              </div>
              <div class="track-height-control">
                <label for="playlist-waveform-opacity">{{ t('settings.waveformOpacity') }}</label>
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
              </div>
              <p class="settings-help">{{ t('settings.waveformOpacityHelp') }}</p>
            </section>
            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">format_size</span>
                {{ t('settings.interfaceFontSize') }}
              </div>
              <div class="track-height-control">
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
              </div>
              <p class="settings-help">{{ t('settings.interfaceFontSizeHelp') }}</p>
            </section>

            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">text_fields</span>
                {{ t('settings.oneShotFontSize') }}
              </div>
              <div class="track-height-control">
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
              </div>
              <p class="settings-help">{{ t('settings.oneShotFontSizeHelp') }}</p>
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
              <p class="settings-help">{{ t('settings.cycleTrackColorsHelp') }}</p>
            </section>

            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">grid_view</span>
                {{ t('settings.cartPlayerLayout') }}
              </div>
              <div class="cart-layout-grid">
                <div class="cart-layout-grid__header">{{ t('settings.cartLayout') }}</div>
                <div class="cart-layout-grid__header">{{ t('settings.minimumCardHeight') }}</div>
                <div class="cart-layout-grid__header">{{ t('settings.visibleRows') }}</div>
                <div class="cart-layout-grid__header">{{ t('settings.columns') }}</div>
                <template v-for="profile in cartGridProfileOptions" :key="profile.id">
                  <div class="cart-layout-grid__profile">{{ profile.label }}</div>
                  <label class="cart-layout-grid__value">
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
                    <span aria-hidden="true">px</span>
                  </label>
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
              <p class="settings-help">{{ t('settings.cartPlayerLayoutHelp') }}</p>
            </section>
            
            <!-- Meter Display Mode -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">bar_chart</span>
                {{ t('settings.meterMode') }}
              </label>
              <select
                class="settings-select"
                :value="meterMode"
                @change="onMeterModeChange"
              >
                <option value="LUFS">{{ t('settings.meterModeLufs') }}</option>
                <option value="dBFS">{{ t('settings.meterModeDbfs') }}</option>
                <option value="dBTP">{{ t('settings.meterModeDbtp') }}</option>
                <option value="RMS">{{ t('settings.meterModeRms') }}</option>
              </select>
              <p class="settings-help">{{ t('settings.meterModeHelp') }}</p>
            </section>

            <!-- Meter Ballistics -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">speed</span>
                {{ t('settings.meterBallistics') }}
              </label>
              <select
                class="settings-select"
                :value="meterBallistics"
                @change="onMeterBallisticsChange"
              >
                <option value="digital-ppm">{{ t('settings.meterBallisticsDigitalPpm') }}</option>
                <option value="ppm-i">{{ t('settings.meterBallisticsPpmI') }}</option>
                <option value="ppm-ii">{{ t('settings.meterBallisticsPpmII') }}</option>
                <option value="vu">{{ t('settings.meterBallisticsVu') }}</option>
                <option value="instant">{{ t('settings.meterBallisticsInstant') }}</option>
              </select>
              <p class="settings-help">{{ t('settings.meterBallisticsHelp') }}</p>
            </section>

            <!-- Time Left countdown colours -->
            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">timer</span>
                {{ t('settings.countdownColors') }}
              </div>
              <p class="settings-help">{{ t('settings.countdownColorsHelp') }}</p>

              <div class="countdown-band-editor">
                <div class="countdown-band-grid countdown-band-grid--header">
                  <span>{{ t('settings.countdownRange') }}</span>
                  <span>{{ t('settings.countdownStartsAt') }}</span>
                  <span>{{ t('settings.countdownColor') }}</span>
                  <span></span>
                </div>
                <div
                  v-for="(band, index) in countdownColorBands"
                  :key="band.startSeconds"
                  class="countdown-band-grid countdown-band-grid--row"
                >
                  <span class="countdown-band-range">
                    <span
                      class="countdown-band-dot"
                      :style="{ backgroundColor: band.color }"
                      aria-hidden="true"
                    ></span>
                    {{ countdownBandRange(index) }}
                  </span>

                  <label class="countdown-band-start">
                    <input
                      v-if="band.startSeconds > 0"
                      type="number"
                      min="1"
                      step="1"
                      :value="band.startSeconds"
                      :aria-label="t('settings.countdownStartsAtFor', { range: countdownBandRange(index) })"
                      @change="onCountdownBandStartChange(index, $event)"
                    />
                    <span v-else class="countdown-band-fixed">0</span>
                    <span>s</span>
                  </label>

                  <label class="countdown-band-color">
                    <input
                      type="color"
                      :value="band.color"
                      :aria-label="t('settings.countdownColorFor', { range: countdownBandRange(index) })"
                      @change="onCountdownBandColorChange(index, $event)"
                    />
                    <span>{{ band.color }}</span>
                  </label>

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
              <button type="button" class="modal-btn countdown-band-add" @click="addCountdownBand">
                <span class="material-symbols-rounded" aria-hidden="true">add</span>
                {{ t('settings.countdownAddBand') }}
              </button>
            </section>

            <!-- Keep the currently-playing item centred in the list -->
            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="scrollToPlaying"
                  @change="onScrollToPlayingChange"
                />
                {{ t('settings.scrollToPlaying') }}
              </label>
              <p class="settings-help">{{ t('settings.scrollToPlayingHelp') }}</p>
            </section>
          </template>
          <!-- ================= Video Output ================= -->
          <template v-else-if="activeTab === 'video'">
            <!-- Enable/arm the output window. Machine-level, immediate. -->
            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="voEnabled"
                  @change="onVideoOutputEnableChange"
                />
                {{ t('settings.videoOutputEnable') }}
              </label>
              <p class="settings-help">{{ t('settings.videoOutputEnableHelp') }}</p>
            </section>

            <!-- Which physical display feeds the switcher/projector -->
            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">monitor</span>
                {{ t('settings.videoOutputDisplay') }}
              </label>
              <div class="video-output-display-row">
                <select
                  class="settings-select"
                  :value="voStatus?.displayId ?? ''"
                  @change="onVideoOutputDisplayChange"
                >
                  <option :value="''">{{ t('settings.videoOutputNoDisplay') }}</option>
                  <option v-for="d in voDisplays" :key="d.id" :value="d.id">
                    {{ d.index }} — {{ d.label }} — {{ d.width }}×{{ d.height }}{{ d.primary ? ' (' + t('common.default') + ')' : '' }}
                  </option>
                </select>
                <button type="button" class="modal-btn video-output-identify" @click="onVideoOutputIdentifyDisplays">
                  <span class="material-symbols-rounded" aria-hidden="true">screenshot_monitor</span>
                  {{ t('settings.videoOutputIdentifyDisplays') }}
                </button>
              </div>
              <p class="settings-help">{{ t('settings.videoOutputDisplayHelp') }}</p>
            </section>

            <!-- Global standby image: shown whenever no cue is supplying
                 picture (below per-cue images and video in the layer stack).
                 Project-level (unlike arm/display, which stay machine-level). -->
            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">image</span>
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
              <p class="settings-help">{{ t('settings.videoOutputStandbyImageHelp') }}</p>
            </section>

            <!-- Test card for the switcher/projector end of the chain -->
            <section class="settings-field">
              <label class="settings-label settings-label--checkbox">
                <input
                  type="checkbox"
                  :checked="voStatus?.testCard === true"
                  :disabled="!voStatus?.open"
                  @change="onVideoOutputTestCardChange"
                />
                {{ t('settings.videoOutputTestCard') }}
              </label>
              <p class="settings-help">{{ t('settings.videoOutputTestCardHelp') }}</p>
            </section>

            <!-- Live status line: where the output is, or why it isn't -->
            <section class="settings-field">
              <div class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">info</span>
                {{ t('settings.videoOutputStatus') }}
              </div>
              <p class="settings-help video-output-status" :class="{ 'video-output-status--warn': !!voWarningText }">
                {{ voWarningText || voStatusText }}
              </p>
              <p class="settings-help">{{ t('settings.videoOutputMachineNote') }}</p>
            </section>
          </template>

          <!-- ================= Help ================= -->
          <template v-else-if="activeTab === 'help'">
            <section class="settings-field">
              <p class="settings-help settings-help-intro">{{ t('settings.helpIntro') }}</p>
              <div class="help-links">
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
              </div>
            </section>

            <section class="settings-field">
              <label class="settings-label">
                <span class="material-symbols-rounded" aria-hidden="true">keyboard</span>
                {{ t('settings.helpShortcutsTitle') }}
              </label>
              <div class="shortcut-summary">
                <div v-for="action in PLAYBACK_ACTIONS" :key="action.id" class="shortcut-summary-row">
                  <span class="shortcut-summary-action">{{ t(action.labelKey) }}</span>
                  <span class="shortcut-summary-key">{{ playbackKeyLabel(action.id) || '—' }}</span>
                </div>
              </div>
              <button type="button" class="help-link help-link--button" @click="emit('open-shortcuts')">
                <span class="material-symbols-rounded" aria-hidden="true">keyboard</span>
                <span>{{ t('settings.helpShortcuts') }}</span>
              </button>
            </section>
          </template>

          <!-- ================= About ================= -->
          <template v-else-if="activeTab === 'about'">
            <AboutContent />
          </template>
        </div>

      <footer class="modal-footer">
        <button class="modal-btn" @click="close">{{ t('settings.close') }}</button>
      </footer>
    </div>

    <ServerFilePickerModal
      :open="voStandbyPickerOpen"
      mode="file"
      filter=".png,.jpg,.jpeg,.webp,.gif,.svg"
      :start-path="voStandbyPickerStart"
      @pick="onVideoOutputStandbyPicked"
      @close="voStandbyPickerOpen = false"
    />
  </div>
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
import AboutContent from './AboutContent.vue';
import { PLAYBACK_ACTIONS, formatKeyLabel, useCartHotkeys } from '~/composables/useCartHotkeys';
import type { PlaybackKeyAction } from '~/types/project';

const props = defineProps<{ open: boolean }>();
const emit  = defineEmits<{ (e: 'close'): void; (e: 'open-shortcuts'): void }>();

const { t } = useLocalization();
const server = useLiveplayServer();

const openExternal = (url: string) => {
  if (import.meta.client && window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
};

// Read-only shortcut summary for the Help tab — same data the editor binds.
const { playbackMappings } = useCartHotkeys();
const playbackKeyLabel = (action: PlaybackKeyAction): string => {
  const binding = playbackMappings.value[action];
  return binding ? formatKeyLabel(binding) : '';
};
const { currentProject, saveProject } = useProject();
const {
  regularPlaylistRowHeight,
  showPlaylistRowHeight,
  folderPlaylistRowHeight,
  waveformOpacity,
  uiFontScale,
  oneShotFontScale,
  cartGridLayouts,
  setRegularPlaylistRowHeight,
  setShowPlaylistRowHeight,
  setFolderPlaylistRowHeight,
  setWaveformOpacity,
  setUiFontScale,
  setOneShotFontScale,
  setCartGridLayout,
} = useUiMode();

const cartGridProfileOptions = computed<Array<{ id: CartGridProfile; label: string }>>(() => [
  { id: 'attachedRegular', label: t('settings.cartLayoutAttachedRegular') },
  { id: 'attachedShow', label: t('settings.cartLayoutAttachedShow') },
  { id: 'detachedRegular', label: t('settings.cartLayoutDetachedRegular') },
  { id: 'detachedShow', label: t('settings.cartLayoutDetachedShow') },
]);

const devices = computed(() => server.devices ?? []);

// Tabs mirror the Properties panel's tab styling. Grouping:
//  - audio    : device routing + loudness target
//  - playback : transitions, auto-cue, stop-all fade, processing toggles
//  - ui       : metering + list behaviour
// help/about are informational tabs, not project settings — nothing in
// them patches the document.
const activeTab = ref<'audio' | 'playback' | 'ui' | 'video' | 'help' | 'about'>('audio');
const tabs = computed(() => [
  { id: 'audio'    as const, icon: 'graphic_eq', label: t('settings.tabAudioRouting') },
  { id: 'playback' as const, icon: 'play_circle', label: t('settings.tabPlaybackBehaviour') },
  { id: 'ui'       as const, icon: 'desktop_windows', label: t('settings.tabUserInterface') },
  { id: 'video'    as const, icon: 'monitor', label: t('settings.tabVideoOutput') },
  // menu_book, NOT help: a circled "?" reads as a tooltip affordance and
  // the operator has repeatedly rejected those.
  { id: 'help'     as const, icon: 'menu_book', label: t('settings.tabHelp') },
  { id: 'about'    as const, icon: 'info', label: t('settings.tabAbout') },
]);

// The settings live on the project document; we read them from there and
// patch via the server endpoint.
const audioDeviceId          = computed(() => (currentProject.value as any)?.settings?.defaultOutputDevice || '');
const previewDeviceId        = computed(() => (currentProject.value as any)?.settings?.previewDevice || '');
const ltcDeviceId            = computed(() => (currentProject.value as any)?.settings?.ltcDevice || '');
const outputTarget           = computed(() => (currentProject.value as any)?.settings?.outputTarget || 'ebu-r128');
const autoTrimSilenceOnImport = computed(() =>
  (currentProject.value as any)?.settings?.autoTrimSilenceOnImport === true);
const autoMatchLoudnessOnImport = computed(() =>
  (currentProject.value as any)?.settings?.autoMatchLoudnessOnImport === true);
const autoReduceTruePeaksOnImport = computed(() =>
  (currentProject.value as any)?.settings?.autoReduceTruePeaksOnImport !== false);
const cycleTrackColors = computed(() =>
  (currentProject.value as any)?.settings?.cycleTrackColors !== false);
const disableLimiter           = computed(() => !!(currentProject.value as any)?.settings?.disableLimiter);
const disableSilenceWarning    = computed(() => !!(currentProject.value as any)?.settings?.disableSilenceWarning);
const defaultTransitionMode    = computed(() => (currentProject.value as any)?.settings?.defaultTransitionMode || 'crossfade');
const indexDisplayStart        = computed(() => normalizeIndexDisplayStart((currentProject.value as any)?.settings?.indexDisplayStart));
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
// Make sure devices are loaded when the modal opens.
watch(() => props.open, async (v) => {
  if (v) await server.fetchDevices();
});
// Video Output tab. Open/closed state is session-only; display assignment is
// machine-level state in the Electron main process (<userData>/video-output.json)
// and deliberately NOT in the project document. All mutations return fresh
// status; the onStatus push keeps this panel live while it is open.
// ---------------------------------------------------------------------------
const voStatus = ref<VideoOutputStatus | null>(null);

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

async function onVideoOutputEnableChange(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  voStatus.value = enabled ? await api.open() : await api.close();
}

async function onVideoOutputDisplayChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  voStatus.value = await api.setDisplay(value || null);
}

async function onVideoOutputIdentifyDisplays() {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  await api.identifyDisplays();
}

async function onVideoOutputTestCardChange(event: Event) {
  const show = (event.target as HTMLInputElement).checked;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  await api.setTestCard(show);
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
  try {
    const dest = await server.copyToMedia(path);
    const folder: string = (currentProject.value as any)?.folderPath || '';
    const relative = folder && dest.startsWith(folder)
      ? dest.slice(folder.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : dest;
    await applyPatch({ videoStandbyImage: relative });
  } catch (e) {
    console.warn('[ProjectSettings] standby image copy failed:', e);
  }
}

function onVideoOutputStandbyClear() {
  void applyPatch({ videoStandbyImage: null });
}

let voOffStatus: (() => void) | null = null;

watch(() => props.open, async (v) => {
  if (!v) return;
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  try { voStatus.value = await api.status(); } catch { /* main not ready yet */ }
});

onMounted(() => {
  const api = window.electronAPI?.videoOutput;
  if (!api) return;
  api.status().then((s) => { voStatus.value = s; }).catch(() => {});
  voOffStatus = api.onStatus((s) => { voStatus.value = s; });
});

onBeforeUnmount(() => {
  voOffStatus?.();
  voOffStatus = null;
});

// Refresh devices on first mount too.
onMounted(async () => {
  try { await server.fetchDevices(); } catch { /* connection may not be ready yet */ }
});

type PatchResult = 'saved' | 'unsaved' | 'failed';

async function applyPatch(patch: Record<string, any>): Promise<PatchResult> {
  // Optimistic local update so the UI reflects the change immediately.
  if (currentProject.value) {
    const settings = ((currentProject.value as any).settings ?? {});
    (currentProject.value as any).settings = { ...settings, ...patch };
  }
  try {
    await server.patchSettings(patch);
  } catch (e) {
    console.warn('[ProjectSettings] patch failed:', e);
    return 'failed';
  }
  return await saveProject() ? 'saved' : 'unsaved';
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
  const previous = countdownColorBands.value.map(band => ({ ...band }));
  countdownBandError.value = '';
  const next = normalizeCountdownColorBands(bands);
  const result = await applyPatch({ countdownColorBands: next });
  if (mutationVersion !== countdownMutationVersion || result === 'saved') return;

  // A failed disk save leaves the accepted live setting in place and visibly
  // unsaved. Only a rejected server patch is safe to roll back.
  if (result === 'failed' && currentProject.value) {
    const settings = ((currentProject.value as any).settings ?? {});
    (currentProject.value as any).settings = {
      ...settings,
      countdownColorBands: previous,
    };
  }
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

function onAudioDeviceChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  applyPatch({ defaultOutputDevice: v || null });
}
function onPreviewDeviceChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  applyPatch({ previewDevice: v || null });
}
function onLtcDeviceChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  applyPatch({ ltcDevice: v || null });
}
function onOutputTargetChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  applyPatch({ outputTarget: v });
}
function onMeterModeChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  applyPatch({ meterMode: v });
}
function onMeterBallisticsChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  applyPatch({ meterBallistics: v });
}
function onAutoTrimSilenceOnImportChange(e: Event) {
  applyPatch({ autoTrimSilenceOnImport: (e.target as HTMLInputElement).checked });
}
function onAutoMatchLoudnessOnImportChange(e: Event) {
  applyPatch({ autoMatchLoudnessOnImport: (e.target as HTMLInputElement).checked });
}
function onAutoReduceTruePeaksOnImportChange(e: Event) {
  applyPatch({ autoReduceTruePeaksOnImport: (e.target as HTMLInputElement).checked });
}
function onCycleTrackColorsChange(e: Event) {
  applyPatch({ cycleTrackColors: (e.target as HTMLInputElement).checked });
}
function onDisableLimiterChange(e: Event) {
  applyPatch({ disableLimiter: (e.target as HTMLInputElement).checked });
}
function onDisableSilenceWarningChange(e: Event) {
  applyPatch({ disableSilenceWarning: (e.target as HTMLInputElement).checked });
}
function onDefaultTransitionModeChange(e: Event) {
  applyPatch({ defaultTransitionMode: (e.target as HTMLSelectElement).value });
}
function onIndexDisplayStartChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const value = normalizeIndexDisplayStart(input.value);
  input.value = String(value);
  applyPatch({ indexDisplayStart: value });
}
function onAutoCueNextChange(e: Event) {
  applyPatch({ autoCueNextWithoutEndBehavior: (e.target as HTMLInputElement).checked });
}
function onStopAllFadeChange(e: Event) {
  const seconds = parseFloat((e.target as HTMLInputElement).value);
  const ms = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 1000;
  applyPatch({ stopAllFadeMs: ms });
}
function onScrollToPlayingChange(e: Event) {
  applyPatch({ uiScrollToPlaying: (e.target as HTMLInputElement).checked });
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
.project-settings-backdrop {
  position: fixed;
  inset: 0;
  background: var(--dialog-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.project-settings-modal {
  background: var(--dialog-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--dialog-radius);
  /* This dialog packs dense grids (countdown bands, audio routing) that
     wrap and force scrolling at the shared 560px token width — give it
     real room; small confirm dialogs keep using --modal-width. */
  width: min(800px, 94vw);
  max-height: var(--modal-max-height);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--dialog-shadow);
  color: var(--color-text-primary);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--dialog-header-padding);
  border-bottom: 1px solid var(--color-border);
}
.modal-header h2 {
  margin: 0;
  font-size: 18px;
}
.close-x {
  display: grid;
  place-items: center;
  width: var(--spacing-xxl);
  height: var(--spacing-xxl);
  padding: 0;
  background: none;
  border: none;
  border-radius: var(--control-radius);
  color: var(--color-text-secondary);
  font-size: 18px;
  cursor: pointer;
}
.close-x:hover {
  color: var(--color-text-primary);
}

/* Tab Navigation — matches PropertiesPanel.vue .properties-tabs / .tab-btn */
.settings-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-surface);
  overflow-x: auto;
}
.tab-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  min-height: 36px;
  padding: 6px var(--spacing-md, 12px);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  transition: all 0.2s;
}
.tab-btn .material-symbols-rounded {
  font-size: 18px;
  color: inherit;
}
.tab-btn:hover {
  color: var(--color-text-primary);
  background-color: var(--color-surface-hover);
}
.tab-btn.active {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.modal-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
}

.settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.settings-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text-secondary);
  font-weight: 500;
}
.settings-select,
.settings-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 14px;
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
.video-output-status {
  font-size: 13px;
  color: var(--color-text-primary);
}
.video-output-status--warn {
  color: var(--color-warning, #f1c21b);
  font-weight: 600;
}
.video-output-display-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: stretch;
}
.video-output-identify {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.video-output-identify .material-symbols-rounded {
  font-size: 18px;
}
.video-output-standby {
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-output-standby-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--color-text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.track-height-control {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 2fr) 52px;
  gap: 12px;
  align-items: center;
  color: var(--color-text-primary);
  font-size: 13px;
}
.track-height-control input[type="range"] {
  width: 100%;
  accent-color: var(--color-accent);
}
.track-height-control output {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.cart-layout-grid {
  display: grid;
  grid-template-columns: minmax(136px, 1.5fr) minmax(92px, 1fr) 72px 72px;
  gap: 6px 8px;
  align-items: center;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
}
.cart-slot-count {
  display: grid;
  grid-template-columns: 1fr 88px;
  gap: 12px;
  align-items: center;
  color: var(--color-text-primary);
  font-size: 13px;
}
.cart-layout-grid__header {
  color: var(--color-text-tertiary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.cart-layout-grid__profile {
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
}
.cart-layout-grid__value {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
}
.cart-layout-input {
  height: 32px;
  min-width: 0;
  padding: 5px 7px;
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

.countdown-band-editor {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}
.countdown-band-grid {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 78px 126px 34px;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
}
.countdown-band-grid--header {
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}
.countdown-band-grid--row {
  min-height: 50px;
  border-top: 1px solid var(--color-border);
}
.countdown-band-range,
.countdown-band-start,
.countdown-band-color {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.countdown-band-range {
  font-size: 12px;
  color: var(--color-text-primary);
}
.countdown-band-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 50%;
}
.countdown-band-start input,
.countdown-band-fixed {
  width: 54px;
  height: 32px;
  padding: 6px 8px;
  background: var(--color-control);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  font: inherit;
  text-align: right;
}
.countdown-band-fixed {
  display: grid;
  place-items: center end;
  color: var(--color-text-secondary);
}
.countdown-band-color input[type="color"] {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  padding: 2px;
  background: var(--color-control);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  cursor: pointer;
}
.countdown-band-color span {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
}
.countdown-band-remove {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
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
.countdown-band-start input:focus-visible,
.countdown-band-color input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.countdown-band-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.countdown-band-add .material-symbols-rounded {
  font-size: 18px;
}
@media (max-width: 480px) {
  .countdown-band-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 34px;
  }
  .countdown-band-grid--header {
    display: none;
  }
  .countdown-band-range {
    grid-column: 1 / -1;
  }
}
.settings-label--checkbox {
  flex-direction: row;
  gap: 10px;
  font-size: 14px;
  color: var(--color-text-primary);
  cursor: pointer;
}
.settings-label--checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--color-accent);
}

.settings-help-intro {
  margin-top: 0;
}

.help-links {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.help-link {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background-color: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
  color: var(--color-text-primary);
  text-decoration: none;
  font-size: 14px;
  text-align: left;
  width: 100%;
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

.shortcut-summary {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--border-radius-md);
  overflow: hidden;
  margin-bottom: var(--spacing-xs);
}

.shortcut-summary-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 12px;
  font-size: 13px;
}

.shortcut-summary-row:nth-child(odd) {
  background: var(--color-background);
}

.shortcut-summary-key {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
}
.modal-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  color: var(--color-text-primary);
  padding: var(--spacing-sm) var(--spacing-lg);
  cursor: pointer;
  font-size: 14px;
}
.modal-btn:hover {
  background: var(--color-surface-hover);
}
</style>
