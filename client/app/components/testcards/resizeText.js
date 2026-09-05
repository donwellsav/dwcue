/*
 * Adapted from vue3-resize-text 0.1.0 by Jayesh Vachhani.
 * The sizing formula and defaults are unchanged. The local version observes the
 * element itself so an embedded card resizes with its actual surface, and it
 * cancels pending work during teardown.
 * License: /assets/testcards/licenses/VUE3-RESIZE-TEXT-MIT.txt
 */

const defaultOptions = {
  delay: 200,
  ratio: 1,
  minFontSize: '16px',
  maxFontSize: '500px'
}

function resize(element) {
  const options = element.__resizeTextOptions
  const size = `${Math.max(
    Math.min(
      element.clientWidth / (options.ratio * 10),
      Number.parseFloat(options.maxFontSize)
    ),
    Number.parseFloat(options.minFontSize)
  )}px`
  element.style.fontSize = size
}

function scheduleResize(element) {
  window.clearTimeout(element.__resizeTextTimer)
  element.__resizeTextTimer = window.setTimeout(() => resize(element), element.__resizeTextOptions.delay)
}

export default {
  mounted(element, binding) {
    element.__resizeTextOptions = {
      ...defaultOptions,
      ...binding.value
    }
    element.__resizeTextHandler = () => scheduleResize(element)
    window.addEventListener('resize', element.__resizeTextHandler, { passive: true })
    element.__resizeTextObserver = new ResizeObserver(element.__resizeTextHandler)
    element.__resizeTextObserver.observe(element)
    resize(element)
  },
  updated(element, binding) {
    element.__resizeTextOptions = {
      ...defaultOptions,
      ...binding.value
    }
    resize(element)
  },
  unmounted(element) {
    window.removeEventListener('resize', element.__resizeTextHandler)
    element.__resizeTextObserver?.disconnect()
    window.clearTimeout(element.__resizeTextTimer)
  }
}
