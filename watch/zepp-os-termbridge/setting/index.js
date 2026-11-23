import { gettext } from 'i18n'
import { normalizeToken } from '../shared/protocol'

AppSettingsPage({
  state: {
    props: {},
    pairingCode: ''
  },
  build(props) {
    this.state.props = props
    this.state.pairingCode = props.settingsStorage.getItem('termbridgePairingCode') || ''
    return View(
      {
        style: {
          padding: '18px 20px'
        }
      },
      [
        Text({
          paragraph: true,
          style: { fontSize: '15px', fontWeight: 'bold', marginBottom: '8px' }
        }, gettext('title')),
        Text({
          paragraph: true,
          style: { color: '#666', fontSize: '13px', marginBottom: '16px' }
        }, gettext('instructions')),
        TextInput({
          label: gettext('pairingCode'),
          value: this.state.pairingCode,
          maxLength: 80,
          onChange: (value) => {
            const token = normalizeToken(value)
            this.state.pairingCode = token
            props.settingsStorage.setItem('termbridgePairingCode', token)
          }
        }),
        Text({
          paragraph: true,
          style: { color: '#888', fontSize: '12px', marginTop: '14px' }
        }, gettext('privacy'))
      ]
    )
  }
})
