import warning from '../utils/warning'

let didWarnAboutReceivingStore = false
function warnAboutReceivingStore() {
  if (didWarnAboutReceivingStore) {
    return
  }
  didWarnAboutReceivingStore = true

  warning('<Provider> does not support changing `store` on the fly.')
}

export function createProvider(storeKey = 'store', subKey) {
    const subscriptionKey = subKey || `${storeKey}Subscription`
    const Provider = {
      props: {
        [storeKey]: {
          type: Object,
          required: true,
        },
      },
      provide() {
        return { [storeKey]: this[storeKey], [subscriptionKey]: null };
      },
      render() {
        const [result] = this.$slots.default || [];
        return result;
      },
    }

    if (process.env.NODE_ENV !== 'production') {
      Provider.watch = {
        store(newStore, oldStore) {
          if (newStore !== oldStore) {
            warnAboutReceivingStore()
          }
        }
      }
    }
    return Provider
}

export default createProvider()
