<template>
  <div
    ref="rootElement"
    id="bounds"
    class="kards-test-card superblack"
    :class="{ showBounds: config.notFilledCard.bounds && !config.windowed }"
  >
    <link rel="stylesheet" :href="'./assets/testcards/fontawesome-scoped.css'" />
    <div class="drag-region" />

    <div
      v-if="config.mask.enabled && config.mask.applyBounds"
      class="overlaymask"
      :style="cardStyle"
    >
      <img :src="config.mask.image" alt="" />
    </div>
    <div v-if="config.mask.enabled && !config.mask.applyBounds" class="overlaymask">
      <img :src="config.mask.image" alt="" />
    </div>

    <div ref="cardSurface" id="cards" :style="cardStyle">
      <InfoCircle
        v-if="showStationaryInfoCircle"
        :config="config"
        :info="info"
      />

      <div
        id="cardForPNG"
        class="testcard"
        :class="{ animated: animatePrimaryCard }"
      >
        <component
          :is="activeCard"
          v-if="activeCard"
          v-bind="primaryCardProps"
        >
          <template #audio-sync>
            <slot name="audio-sync" :rate="config.audioSync.rate">
              <div id="test-card-video-target" />
            </slot>
          </template>
        </component>
      </div>

      <div v-if="duplicateCard" class="testcard animatedAbove">
        <component :is="activeCard" :config="config" :info="info" />
      </div>
      <div v-if="duplicateCard" class="testcard animatedLeft">
        <component :is="activeCard" :config="config" :info="info" />
      </div>
      <div v-if="duplicateCard" class="testcard animatedAboveLeft">
        <component :is="activeCard" :config="config" :info="info" />
      </div>
    </div>

    <Transition name="fade">
      <div v-if="config.notFilledCard.bounds && !config.windowed" class="infoBounds">
        <strong>{{ config.name }}</strong><br />
        {{ boundsInfo }}
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ARIB from './ARIB.vue'
import Alteka from './Alteka.vue'
import AudioSync from './AudioSync.vue'
import Bars from './Bars.vue'
import Deghost from './Deghost.vue'
import Grid from './Grid.vue'
import HDR from './HDR.vue'
import InfoCircle from './InfoCircle.vue'
import LedWall from './LedWall.vue'
import Placeholder from './Placeholder.vue'
import Ramp from './Ramp.vue'
import SDI from './SDI.vue'
import Single from './Single.vue'
import SMPTE from './SMPTE.vue'

const props = defineProps({
  config: {
    type: Object,
    required: true
  },
  displayFrequency: {
    type: Number,
    default: 0
  },
  network: {
    type: Array,
    default: () => []
  },
  audioDescription: {
    type: String,
    default: 'Native audio'
  }
})

const rootElement = ref(null)
const cardSurface = ref(null)
const boundsInfo = ref('0 x 0')
const borderSize = ref(25)
const info = reactive({
  cardSize: '',
  circleSize: 500,
  displayFrequency: 0,
  time: '00:00',
  network: [],
  networkIndex: 0,
  rootWidth: 0,
  rootHeight: 0
})

let resizeObserver
let timeInterval
let networkInterval

const animationEnabled = computed(() => Boolean(props.config.animated))

const activeCard = computed(() => {
  switch (props.config.cardType) {
    case 'grid':
      return Grid
    case 'ramp':
      return Ramp
    case 'audioSync':
      return AudioSync
    case 'placeholder':
      return Placeholder
    case 'alteka':
      return Alteka
    case 'led':
      return LedWall
    case 'deghost':
      return Deghost
    case 'bars':
      switch (props.config.bars.type) {
        case 'smpte':
          return SMPTE
        case 'arib':
          return ARIB
        case 'simple':
          return Bars
        case 'hdr':
          return HDR
        case 'sdi':
          return SDI
        case 'single':
          return Single
        default:
          return null
      }
    default:
      return null
  }
})

const primaryCardProps = computed(() => {
  const cardProps = {
    config: props.config,
    info
  }
  if (props.config.cardType === 'alteka' || props.config.cardType === 'audioSync') {
    cardProps.borderSize = borderSize.value
  }
  if (props.config.cardType === 'audioSync') {
    cardProps.audioDescription = props.audioDescription
  }
  return cardProps
})

const duplicateCard = computed(() => {
  if (!animationEnabled.value) return false
  return !['alteka', 'audioSync', 'led', 'deghost'].includes(props.config.cardType)
})

const animatePrimaryCard = computed(() => duplicateCard.value)

const showStationaryInfoCircle = computed(() => {
  if (props.config.infoCircleAnimated) return false
  if (props.config.cardType === 'grid' || props.config.cardType === 'ramp') return true
  return props.config.cardType === 'bars' && props.config.bars.type !== 'hdr'
})

const cardStyle = computed(() => {
  const style = {}
  if (!props.config.fullsize && props.config.screen !== 0) {
    style.height = `${props.config.notFilledCard.height}px`
    style.width = `${props.config.notFilledCard.width}px`
    style.top = `${props.config.notFilledCard.top}px`
    style.left = `${props.config.notFilledCard.left}px`
  }

  style.border = props.config.raster && !props.config.windowed ? '1px solid white' : 'none'

  switch (props.config.notFilledCard.rotate) {
    case 90:
      style.transform = 'rotate(90deg) translateY(-100%)'
      style.transformOrigin = 'top left'
      break
    case 180:
      style.transform = 'rotate(180deg)'
      break
    case 270:
      style.transform = 'rotate(270deg) translateX(-100%)'
      style.transformOrigin = 'top left'
      break
  }

  return style
})

function zeroPad(number, digits) {
  return `${'0'.repeat(digits)}${number}`.slice(-digits)
}

function updateTime() {
  const date = new Date()
  info.time = `${zeroPad(date.getHours(), 2)}:${zeroPad(date.getMinutes(), 2)}:${zeroPad(date.getSeconds(), 2)}`
}

function updateBorderSize(width, height) {
  let size = 25
  if (width < 720 || height < 720) size = 20
  if (width < 600 || height < 600) size = 15
  if (width < 400 || height < 400) size = 10
  if (width < 250 || height < 250) size = 6
  borderSize.value = size
}

function updateInfoCircleSize(width, height) {
  let size = 500
  if (width < 1600 || height < 1600) size = 400
  if (width < 1300 || height < 1300) size = 300
  if (width < 900 || height < 900) size = 200
  if (width < 500 || height < 500) size = 150
  if (width < 300 || height < 300) size = 100
  info.circleSize = size
}

function updateDimensions() {
  const rootRect = rootElement.value?.getBoundingClientRect()
  const cardRect = cardSurface.value?.getBoundingClientRect() ?? rootRect
  if (!rootRect || !cardRect || cardRect.width <= 0 || cardRect.height <= 0) return

  const rootWidth = Math.round(rootRect.width)
  const rootHeight = Math.round(rootRect.height)
  const width = Math.round(cardRect.width)
  const height = Math.round(cardRect.height)

  boundsInfo.value = `${rootWidth} x ${rootHeight}`
  info.cardSize = `${width} x ${height}`
  info.rootWidth = rootWidth
  info.rootHeight = rootHeight
  updateBorderSize(width, height)
  updateInfoCircleSize(width, height)
}

function restartNetworkRotation() {
  info.networkIndex = 0
  if (typeof window === 'undefined') return

  window.clearInterval(networkInterval)
  networkInterval = undefined
  if (info.network.length > 1) {
    networkInterval = window.setInterval(() => {
      info.networkIndex = (info.networkIndex + 1) % info.network.length
    }, 5000)
  }
}

watch(
  () => props.displayFrequency,
  (value) => {
    info.displayFrequency = value
  },
  { immediate: true }
)

watch(
  () => props.network,
  (value) => {
    info.network = value
    restartNetworkRotation()
  },
  { deep: true, immediate: true }
)

watch(
  () => props.config,
  async () => {
    await nextTick()
    updateDimensions()
  },
  { deep: true }
)

onMounted(async () => {
  await nextTick()
  resizeObserver = new ResizeObserver(updateDimensions)
  resizeObserver.observe(rootElement.value)
  resizeObserver.observe(cardSurface.value)
  updateDimensions()

  updateTime()
  timeInterval = window.setInterval(updateTime, 1000)
  restartNetworkRotation()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.clearInterval(timeInterval)
  window.clearInterval(networkInterval)
})
</script>

<style scoped>
.kards-test-card {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: Sansation, Helvetica, sans-serif;
  background-color: #000;
  isolation: isolate;
}

#cards {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  color: white;
  border: 0 solid white;
  box-sizing: border-box;
  overflow: hidden;
}

.overlaymask {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 10;
  user-select: none;
  -webkit-user-drag: none;
  -webkit-user-select: none;
  mix-blend-mode: darken;
}

.overlaymask img {
  width: 100%;
  height: 100%;
  user-select: none;
  -webkit-user-drag: none;
  -webkit-user-select: none;
}

.drag-region {
  top: 4px;
  left: 4px;
  display: block;
  position: absolute;
  width: calc(100% - 8px);
  height: calc(100% - 8px);
  z-index: -1;
  -webkit-app-region: drag;
}

.infoBounds {
  position: absolute;
  font-size: 20px;
  width: 150px;
  height: 95px;
  padding-top: 55px;
  margin: auto;
  left: calc(50% - 75px);
  top: calc(50% - 75px);
  text-align: center;
  border-radius: 50%;
  overflow: hidden;
  color: red;
  background: rgb(0 0 0 / 60%);
  border: 1px solid red;
  z-index: 11;
}

.testcard {
  height: 100%;
  width: 100%;
  position: absolute;
  inset: 0;
}

.animated {
  animation: diagonal 30s infinite linear;
}

.animatedAbove {
  animation: diagonalAbove 30s infinite linear;
}

.animatedLeft {
  animation: diagonalLeft 30s infinite linear;
}

.animatedAboveLeft {
  animation: diagonalAboveLeft 30s infinite linear;
}

@keyframes diagonal {
  0% { transform: translateX(0%) translateY(0%); }
  100% { transform: translateX(100%) translateY(100%); }
}

@keyframes diagonalAbove {
  0% { transform: translateX(0%) translateY(-100%); }
  100% { transform: translateX(100%) translateY(0%); }
}

@keyframes diagonalLeft {
  0% { transform: translateX(-100%) translateY(0%); }
  100% { transform: translateX(0%) translateY(100%); }
}

@keyframes diagonalAboveLeft {
  0% { transform: translateX(-100%) translateY(-100%); }
  100% { transform: translateX(0%) translateY(0%); }
}

.showBounds {
  outline: 2px solid red;
  outline-offset: -2px;
  background-size: 50% 50%;
  background-image:
    linear-gradient(to right, red 1px, transparent 1px),
    linear-gradient(to bottom, red 1px, transparent 1px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.5s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

</style>
