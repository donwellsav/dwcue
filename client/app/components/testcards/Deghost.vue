<template>
  <div id="Deghost" :style="deghostStyle">
    <InfoCircle :config="config" :info="info" class="info" />
    <div :id="particleTargetId" class="particles" />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, useId, watch } from 'vue'
import InfoCircle from './InfoCircle.vue'

const props = defineProps({
  config: Object,
  info: Object
})

let particlesScriptPromise

function loadParticlesScript() {
  if (window.particlesJS) return Promise.resolve()
  if (particlesScriptPromise) return particlesScriptPromise

  particlesScriptPromise = new Promise((resolve, reject) => {
    const source = new URL('./assets/testcards/particles.js', document.baseURI).href
    const existing = document.querySelector(`script[src="${source}"]`)
    const script = existing ?? document.createElement('script')

    const handleLoad = () => {
      if (window.particlesJS) resolve()
      else reject(new Error('particles.js loaded without registering particlesJS'))
    }
    const handleError = () => reject(new Error('Unable to load particles.js'))

    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })

    if (!existing) {
      script.src = source
      script.async = true
      document.head.appendChild(script)
    }
  })

  return particlesScriptPromise
}

const particleTargetId = `particles-js${useId().replaceAll(':', '-')}`
const deghostStyle = computed(() => ({
  animationDuration: `${Math.abs(15 - props.config.deghost.speed)}s`
}))
const particlesConfig = computed(() => ({
  particles: {
    number: {
      value: props.config.deghost.density,
      density: {
        enable: true,
        value_area: 1000
      }
    },
    color: {
      value: '#ffffff'
    },
    shape: {
      type: 'circle',
      stroke: {
        width: 5,
        color: '#000000'
      }
    },
    opacity: {
      value: 1.0,
      random: false,
      anim: {
        enable: false,
        speed: 1,
        opacity_min: 0.1,
        sync: false
      }
    },
    size: {
      value: 8,
      random: false,
      anim: {
        enable: false,
        speed: 80,
        size_min: 0.1,
        sync: false
      }
    },
    line_linked: {
      enable: true,
      distance: 200,
      color: '#000',
      opacity: 1.0,
      width: 2
    },
    move: {
      enable: true,
      speed: props.config.deghost.speed,
      direction: 'none',
      random: true,
      straight: false,
      out_mode: 'out',
      bounce: false
    }
  },
  interactivity: {
    detect_on: 'canvas',
    events: {
      onclick: {
        enable: false,
        mode: 'push'
      },
      onhover: {
        enable: false
      },
      resize: true
    }
  },
  retina_detect: true
}))

let mounted = false
let renderGeneration = 0

function findParticleEntryIndex() {
  if (!Array.isArray(window.pJSDom)) return -1
  return window.pJSDom.findIndex((entry) => (
    entry?.pJS?.canvas?.el?.parentElement?.id === particleTargetId
  ))
}

function destroyParticles() {
  const index = findParticleEntryIndex()
  if (index < 0) return

  const entry = window.pJSDom[index]
  entry.pJS.fn.vendors.destroypJS()
  window.pJSDom.splice(index, 1)
}

async function renderParticles() {
  if (!mounted) return
  const generation = ++renderGeneration
  destroyParticles()

  try {
    await loadParticlesScript()
    await nextTick()
    if (!mounted || generation !== renderGeneration) return
    window.particlesJS(particleTargetId, particlesConfig.value)
  } catch (error) {
    console.error('Unable to initialize Deghost particles', error)
  }
}

watch(
  () => [
    props.config.deghost.density,
    props.config.deghost.speed
  ],
  renderParticles
)

onMounted(() => {
  mounted = true
  renderParticles()
})

onBeforeUnmount(() => {
  mounted = false
  renderGeneration += 1
  destroyParticles()
})
</script>

<style scoped>
.info {
  animation: circle 20s linear infinite;
}

@keyframes circle {
  0% {
    transform: rotate(0deg) translate(-100%) rotate(0deg);
  }
  100% {
    transform: rotate(360deg) translate(-100%) rotate(-360deg);
  }
}

#Deghost {
  overflow: hidden;
  background: #000;
  height: 100%;
  width: 100%;
  color: white;
  animation-name: backgroundColorPalette;
  animation-duration: 5s;
  animation-iteration-count: infinite;
  animation-direction: normal;
  animation-timing-function: linear;
}

.particles {
  height: 100%;
  width: 100%;
}

@keyframes backgroundColorPalette {
  0% { background: hsl(0deg 100% 50%); }
  8.333% { background: hsl(30deg 100% 50%); }
  16.667% { background: hsl(60deg 100% 50%); }
  25% { background: hsl(90deg 100% 50%); }
  33.333% { background: hsl(120deg 100% 50%); }
  41.667% { background: hsl(150deg 100% 50%); }
  50% { background: hsl(180deg 100% 50%); }
  58.333% { background: hsl(210deg 100% 50%); }
  66.667% { background: hsl(240deg 100% 50%); }
  75% { background: hsl(270deg 100% 50%); }
  83.333% { background: hsl(300deg 100% 50%); }
  91.667% { background: hsl(330deg 100% 50%); }
  100% { background: hsl(360deg 100% 50%); }
}
</style>
