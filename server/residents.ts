// The wing's residents and the simulated device each one wears.

export interface ResidentSeed {
  id: string
  name: string
  room: string
  simDevice: string
  simFirmware: string
}

export const residentSeeds: ResidentSeed[] = [
  { id: '1', name: 'Margaret Ellis', room: '101', simDevice: 'ST-0412', simFirmware: '1.4.2' },
  { id: '2', name: 'Harold Brooks', room: '102', simDevice: 'ST-0388', simFirmware: '1.4.2' },
  { id: '3', name: 'Dorothy Kim', room: '103', simDevice: 'ST-0419', simFirmware: '1.4.2' },
  { id: '4', name: 'Walter Nguyen', room: '104', simDevice: 'ST-0371', simFirmware: '1.3.9' },
  { id: '5', name: 'Evelyn Carter', room: '105', simDevice: 'ST-0402', simFirmware: '1.4.2' },
  { id: '6', name: 'Frank Morales', room: '106', simDevice: 'ST-0395', simFirmware: '1.4.2' },
  { id: '7', name: 'Ruth Patel', room: '107', simDevice: 'ST-0407', simFirmware: '1.4.2' },
  { id: '8', name: 'George Hall', room: '108', simDevice: 'ST-0366', simFirmware: '1.3.9' },
]
