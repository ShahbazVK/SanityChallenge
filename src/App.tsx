import {type SanityConfig} from '@sanity/sdk'
import {SanityApp} from '@sanity/sdk-react'
import {Flex, Spinner} from '@sanity/ui'
import {SanityUI} from './SanityUI'
import {TriageDashboard} from './components/TriageDashboard'

function App() {
  // apps can access many different projects or other sources of data
  const sanityConfigs: SanityConfig[] = [
    {
      projectId: 'cqb58l0f',
      dataset: 'production',
    },
  ]

  function Loading() {
    return (
      <Flex align="center" justify="center" height="fill" style={{width: '100vw'}}>
        <Spinner />
      </Flex>
    )
  }

  return (
    <SanityUI>
      <SanityApp config={sanityConfigs} fallback={<Loading />}>
        <TriageDashboard />
      </SanityApp>
    </SanityUI>
  )
}

export default App

